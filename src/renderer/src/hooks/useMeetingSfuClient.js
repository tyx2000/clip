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

// 这个 hook 只负责 renderer 侧 mediasoup-client 的 transport 壳：
// 1. 当前阶段只初始化 Device，并创建 send/recv transport。
// 2. 不 produce / consume 任何媒体，先把 SFU 传输层的本地状态接起来。
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
  const inFlightCreateSendTransportRef = useRef(null)
  const inFlightCreateRecvTransportRef = useRef(null)

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

          sendTransportRef.current = transport
          setSendTransport(transport)
          return transport
        })().finally(() => {
          inFlightCreateSendTransportRef.current = null
        })
      }

      return await inFlightCreateSendTransportRef.current
    },
    [attachTransportHandlers, sendRequestWithDeferred]
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

      if (message.type === 'error') {
        const nextError = new Error(message.message || 'SFU signaling failed.')
        settleDeferred(pendingCreateSendTransportRef, null, nextError)
        settleDeferred(pendingCreateRecvTransportRef, null, nextError)
        settleDeferred(pendingConnectSendTransportRef, null, nextError)
        settleDeferred(pendingConnectRecvTransportRef, null, nextError)
      }
    },
    [settleDeferred]
  )

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
      async publishAudio() {
        throw new Error('useMeetingSfuClient.publishAudio is not implemented yet.')
      },
      async publishCamera() {
        throw new Error('useMeetingSfuClient.publishCamera is not implemented yet.')
      },
      async publishScreen() {
        throw new Error('useMeetingSfuClient.publishScreen is not implemented yet.')
      },
      async closeProducer() {
        throw new Error('useMeetingSfuClient.closeProducer is not implemented yet.')
      },
      async consumeProducer() {
        throw new Error('useMeetingSfuClient.consumeProducer is not implemented yet.')
      },
      async closePeerConsumers() {
        throw new Error('useMeetingSfuClient.closePeerConsumers is not implemented yet.')
      }
    }),
    [
      device,
      ensureRecvTransport,
      ensureSendTransport,
      handleSocketMessage,
      initializeDevice,
      recvTransport,
      reset,
      routerRtpCapabilities,
      sendTransport
    ]
  )
}
