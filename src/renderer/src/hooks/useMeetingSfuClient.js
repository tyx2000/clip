import { Device } from 'mediasoup-client'
import { useCallback, useMemo, useRef, useState } from 'react'

function createDeferred() {
  let resolve = null
  let reject = null
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, resolve, reject }
}

function createRequestId(prefix = 'sfu-request-') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID()}`
  }
  return `${prefix}${Math.random().toString(16).slice(2, 10)}`
}

// 这个 hook 负责 renderer 侧 mediasoup-client 生命周期：
// 1. 初始化 Device，并创建 send/recv transport。
// 2. 发布本地麦克风/屏幕 track，消费远端 producer。
// 3. 信令仍走主进程持有的会议 WS。
export function useMeetingSfuClient() {
  const [device, setDevice] = useState(null)
  const [routerRtpCapabilities, setRouterRtpCapabilities] = useState(null)
  const [sendTransport, setSendTransport] = useState(null)
  const [recvTransport, setRecvTransport] = useState(null)

  const deviceRef = useRef(null)
  const sendTransportRef = useRef(null)
  const recvTransportRef = useRef(null)
  const pendingCreateSendTransportRef = useRef(null)
  const pendingCreateRecvTransportRef = useRef(null)
  const pendingConnectSendTransportRef = useRef(null)
  const pendingConnectRecvTransportRef = useRef(null)
  const pendingProduceRequestsRef = useRef(new Map())
  const pendingConsumeRequestsRef = useRef(new Map())
  const inFlightCreateSendTransportRef = useRef(null)
  const inFlightCreateRecvTransportRef = useRef(null)
  const producersRef = useRef(new Map())
  const consumersRef = useRef(new Map())

  const settleDeferred = useCallback((ref, payload, error = null) => {
    if (!ref.current) {
      return
    }

    const deferred = ref.current
    ref.current = null
    if (error) {
      deferred.reject(error)
      return
    }

    deferred.resolve(payload)
  }, [])

  const reset = useCallback(() => {
    sendTransportRef.current?.close()
    recvTransportRef.current?.close()
    sendTransportRef.current = null
    recvTransportRef.current = null
    setSendTransport(null)
    setRecvTransport(null)

    settleDeferred(
      pendingCreateSendTransportRef,
      null,
      new Error('SFU session reset before send transport completed.')
    )
    settleDeferred(
      pendingCreateRecvTransportRef,
      null,
      new Error('SFU session reset before recv transport completed.')
    )
    settleDeferred(
      pendingConnectSendTransportRef,
      null,
      new Error('SFU session reset before send transport connected.')
    )
    settleDeferred(
      pendingConnectRecvTransportRef,
      null,
      new Error('SFU session reset before recv transport connected.')
    )

    inFlightCreateSendTransportRef.current = null
    inFlightCreateRecvTransportRef.current = null
    for (const producer of producersRef.current.values()) {
      producer.close()
    }
    for (const consumer of consumersRef.current.values()) {
      consumer.close()
    }
    producersRef.current.clear()
    consumersRef.current.clear()
    pendingProduceRequestsRef.current.forEach((deferred) => {
      deferred.reject(new Error('SFU session reset before media publish completed.'))
    })
    pendingConsumeRequestsRef.current.forEach((deferred) => {
      deferred.reject(new Error('SFU session reset before media consume completed.'))
    })
    pendingProduceRequestsRef.current.clear()
    pendingConsumeRequestsRef.current.clear()
  }, [settleDeferred])

  const initializeDevice = useCallback(async (nextRouterRtpCapabilities) => {
    if (!nextRouterRtpCapabilities) {
      throw new Error('router RTP capabilities are required.')
    }

    if (deviceRef.current) {
      setRouterRtpCapabilities(nextRouterRtpCapabilities)
      return deviceRef.current
    }

    const nextDevice = new Device()
    await nextDevice.load({ routerRtpCapabilities: nextRouterRtpCapabilities })

    deviceRef.current = nextDevice
    setDevice(nextDevice)
    setRouterRtpCapabilities(nextRouterRtpCapabilities)
    return nextDevice
  }, [])

  const sendRequestWithDeferred = useCallback(
    (sendSocketMessage, payload, pendingRef, errorText) => {
      pendingRef.current = createDeferred()
      const sent = sendSocketMessage(payload)
      if (!sent) {
        const deferred = pendingRef.current
        pendingRef.current = null
        deferred.reject(new Error(errorText))
        return deferred.promise
      }

      return pendingRef.current.promise
    },
    []
  )

  const attachTransportHandlers = useCallback(
    (transport, { sendSocketMessage, connectType, pendingConnectRef, connectErrorText }) => {
      transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await sendRequestWithDeferred(
            sendSocketMessage,
            {
              type: connectType,
              dtlsParameters
            },
            pendingConnectRef,
            connectErrorText
          )
          callback()
        } catch (error) {
          errback(error)
        }
      })
    },
    [sendRequestWithDeferred]
  )

  const sendRequestWithRequestId = useCallback(
    (sendSocketMessage, payload, pendingMap, errorText) => {
      const requestId = createRequestId()
      const deferred = createDeferred()
      pendingMap.current.set(requestId, deferred)
      const sent = sendSocketMessage({
        ...payload,
        requestId
      })
      if (!sent) {
        pendingMap.current.delete(requestId)
        deferred.reject(new Error(errorText))
      }
      return deferred.promise
    },
    []
  )

  const attachSendTransportProduceHandler = useCallback(
    (transport, sendSocketMessage) => {
      transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          const message = await sendRequestWithRequestId(
            sendSocketMessage,
            {
              type: 'produce',
              kind,
              rtpParameters,
              appData
            },
            pendingProduceRequestsRef,
            'Failed to request SFU producer.'
          )
          const producerId = message.producer?.producerId
          if (!producerId) {
            throw new Error('SFU server did not return a producer id.')
          }
          callback({ id: producerId })
        } catch (error) {
          errback(error)
        }
      })
    },
    [sendRequestWithRequestId]
  )

  const ensureSendTransport = useCallback(
    async (sendSocketMessage) => {
      if (sendTransportRef.current) {
        return sendTransportRef.current
      }

      if (!deviceRef.current) {
        throw new Error('SFU device is not initialized yet.')
      }

      if (!inFlightCreateSendTransportRef.current) {
        inFlightCreateSendTransportRef.current = (async () => {
          const transportMessage = await sendRequestWithDeferred(
            sendSocketMessage,
            { type: 'create-send-transport' },
            pendingCreateSendTransportRef,
            'Failed to request SFU send transport.'
          )

          const transport = deviceRef.current.createSendTransport(transportMessage.transportOptions)
          attachTransportHandlers(transport, {
            sendSocketMessage,
            connectType: 'connect-send-transport',
            pendingConnectRef: pendingConnectSendTransportRef,
            connectErrorText: 'Failed to connect SFU send transport.'
          })
          attachSendTransportProduceHandler(transport, sendSocketMessage)

          sendTransportRef.current = transport
          setSendTransport(transport)
          return transport
        })().finally(() => {
          inFlightCreateSendTransportRef.current = null
        })
      }

      return await inFlightCreateSendTransportRef.current
    },
    [attachSendTransportProduceHandler, attachTransportHandlers, sendRequestWithDeferred]
  )

  const ensureRecvTransport = useCallback(
    async (sendSocketMessage) => {
      if (recvTransportRef.current) {
        return recvTransportRef.current
      }

      if (!deviceRef.current) {
        throw new Error('SFU device is not initialized yet.')
      }

      if (!inFlightCreateRecvTransportRef.current) {
        inFlightCreateRecvTransportRef.current = (async () => {
          const transportMessage = await sendRequestWithDeferred(
            sendSocketMessage,
            { type: 'create-recv-transport' },
            pendingCreateRecvTransportRef,
            'Failed to request SFU recv transport.'
          )

          const transport = deviceRef.current.createRecvTransport(transportMessage.transportOptions)
          attachTransportHandlers(transport, {
            sendSocketMessage,
            connectType: 'connect-recv-transport',
            pendingConnectRef: pendingConnectRecvTransportRef,
            connectErrorText: 'Failed to connect SFU recv transport.'
          })

          recvTransportRef.current = transport
          setRecvTransport(transport)
          return transport
        })().finally(() => {
          inFlightCreateRecvTransportRef.current = null
        })
      }

      return await inFlightCreateRecvTransportRef.current
    },
    [attachTransportHandlers, sendRequestWithDeferred]
  )

  const handleSocketMessage = useCallback(
    (message) => {
      if (!message?.type) {
        return
      }

      if (message.type === 'send-transport-created') {
        settleDeferred(pendingCreateSendTransportRef, message)
        return
      }

      if (message.type === 'recv-transport-created') {
        settleDeferred(pendingCreateRecvTransportRef, message)
        return
      }

      if (message.type === 'connect-send-transport') {
        settleDeferred(pendingConnectSendTransportRef, message)
        return
      }

      if (message.type === 'connect-recv-transport') {
        settleDeferred(pendingConnectRecvTransportRef, message)
        return
      }

      if (message.type === 'produced' && message.requestId) {
        const deferred = pendingProduceRequestsRef.current.get(message.requestId)
        if (deferred) {
          pendingProduceRequestsRef.current.delete(message.requestId)
          deferred.resolve(message)
        }
        return
      }

      if (message.type === 'consumed' && message.requestId) {
        const deferred = pendingConsumeRequestsRef.current.get(message.requestId)
        if (deferred) {
          pendingConsumeRequestsRef.current.delete(message.requestId)
          deferred.resolve(message)
        }
        return
      }

      if (message.type === 'error') {
        const nextError = new Error(message.message || 'SFU signaling failed.')
        let matchedRequest = false
        if (message.requestId) {
          const produceDeferred = pendingProduceRequestsRef.current.get(message.requestId)
          if (produceDeferred) {
            pendingProduceRequestsRef.current.delete(message.requestId)
            matchedRequest = true
            produceDeferred.reject(nextError)
          }
          const consumeDeferred = pendingConsumeRequestsRef.current.get(message.requestId)
          if (consumeDeferred) {
            pendingConsumeRequestsRef.current.delete(message.requestId)
            matchedRequest = true
            consumeDeferred.reject(nextError)
          }
        }
        if (message.requestId && !matchedRequest) {
          return
        }
        settleDeferred(pendingCreateSendTransportRef, null, nextError)
        settleDeferred(pendingCreateRecvTransportRef, null, nextError)
        settleDeferred(pendingConnectSendTransportRef, null, nextError)
        settleDeferred(pendingConnectRecvTransportRef, null, nextError)
      }
    },
    [settleDeferred]
  )

  const publishTrack = useCallback(
    async (sendSocketMessage, track, { stream = null, source = '', peerId = '' } = {}) => {
      if (!track) {
        throw new Error('media track is required.')
      }

      const transport = await ensureSendTransport(sendSocketMessage)
      const producer = await transport.produce({
        track,
        appData: {
          source,
          peerId
        }
      })
      producersRef.current.set(producer.id, producer)
      producer.on('transportclose', () => {
        producersRef.current.delete(producer.id)
      })
      producer.on('trackended', () => {
        producersRef.current.delete(producer.id)
      })
      producer.on('close', () => {
        producersRef.current.delete(producer.id)
      })

      return {
        producer,
        stream
      }
    },
    [ensureSendTransport]
  )

  const consumeProducer = useCallback(
    async (sendSocketMessage, producerInfo) => {
      if (!deviceRef.current) {
        throw new Error('SFU device is not initialized yet.')
      }
      if (!producerInfo?.producerId) {
        throw new Error('producerId is required.')
      }

      const transport = await ensureRecvTransport(sendSocketMessage)
      const message = await sendRequestWithRequestId(
        sendSocketMessage,
        {
          type: 'consume',
          producerId: producerInfo.producerId,
          rtpCapabilities: deviceRef.current.rtpCapabilities
        },
        pendingConsumeRequestsRef,
        'Failed to request SFU consumer.'
      )
      const consumerOptions = message.consumer
      const consumer = await transport.consume({
        id: consumerOptions.id,
        producerId: consumerOptions.producerId,
        kind: consumerOptions.kind,
        rtpParameters: consumerOptions.rtpParameters,
        appData: {
          ...(consumerOptions.appData || {}),
          ...(producerInfo.appData || {}),
          producerPeerId: consumerOptions.producerPeerId || producerInfo.peerId || ''
        }
      })
      consumersRef.current.set(consumer.id, consumer)
      consumer.on('transportclose', () => {
        consumersRef.current.delete(consumer.id)
      })
      consumer.on('producerclose', () => {
        consumersRef.current.delete(consumer.id)
      })
      return consumer
    },
    [ensureRecvTransport, sendRequestWithRequestId]
  )

  const closeProducer = useCallback((sendSocketMessage, producerOrId) => {
    const producerId = typeof producerOrId === 'string' ? producerOrId : producerOrId?.id || ''
    if (!producerId) {
      return false
    }

    const producer = producersRef.current.get(producerId)
    producer?.close()
    producersRef.current.delete(producerId)
    sendSocketMessage({
      type: 'close-producer',
      producerId
    })
    return true
  }, [])

  const closeConsumer = useCallback((consumerOrId) => {
    const consumerId = typeof consumerOrId === 'string' ? consumerOrId : consumerOrId?.id || ''
    if (!consumerId) {
      return false
    }

    const consumer = consumersRef.current.get(consumerId)
    consumer?.close()
    consumersRef.current.delete(consumerId)
    return true
  }, [])

  return useMemo(
    () => ({
      device,
      routerRtpCapabilities,
      sendTransport,
      recvTransport,
      isInitialized: Boolean(device),
      initializeDevice,
      ensureSendTransport,
      ensureRecvTransport,
      handleSocketMessage,
      reset,
      publishTrack,
      publishAudio: publishTrack,
      async publishCamera() {
        throw new Error('useMeetingSfuClient.publishCamera is not implemented yet.')
      },
      publishScreen: publishTrack,
      closeProducer,
      consumeProducer,
      closeConsumer
    }),
    [
      device,
      ensureRecvTransport,
      ensureSendTransport,
      handleSocketMessage,
      initializeDevice,
      closeConsumer,
      closeProducer,
      consumeProducer,
      publishTrack,
      recvTransport,
      reset,
      routerRtpCapabilities,
      sendTransport
    ]
  )
}
