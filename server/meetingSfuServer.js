function createMeetingSfuServer() {
  const roomsMedia = new Map()
  let workerPromise = null
  const announcedAddress = String(process.env.SFU_ANNOUNCED_ADDRESS || '').trim() || undefined
  const WEBRTC_TRANSPORT_OPTIONS = {
    listenInfos: [
      {
        protocol: 'udp',
        ip: process.env.SFU_LISTEN_IP || '127.0.0.1',
        announcedAddress
      },
      {
        protocol: 'tcp',
        ip: process.env.SFU_LISTEN_IP || '127.0.0.1',
        announcedAddress
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  }

  async function loadMediasoup() {
    try {
      return require('mediasoup')
    } catch (error) {
      throw new Error(
        `mediasoup dependency is not installed. Run npm install mediasoup mediasoup-client before using SFU features. ${error instanceof Error ? error.message : ''}`.trim()
      )
    }
  }

  async function ensureWorker() {
    if (!workerPromise) {
      workerPromise = loadMediasoup().then((mediasoup) =>
        mediasoup.createWorker({
          logLevel: 'warn'
        })
      )
      workerPromise
        .then((worker) => {
          worker.on('died', () => {
            roomsMedia.clear()
            workerPromise = null
          })
        })
        .catch(() => {
          workerPromise = null
        })
    }

    return await workerPromise
  }

  function createRoomMediaState({ router }) {
    return {
      router,
      peers: new Map()
    }
  }

  function getOrCreatePeerState(roomMedia, peerId) {
    let peerState = roomMedia.peers.get(peerId)
    if (!peerState) {
      peerState = {
        sendTransport: null,
        recvTransport: null,
        producers: new Map(),
        consumers: new Map(),
        consumerProducerIds: new Map()
      }
      roomMedia.peers.set(peerId, peerState)
    }
    return peerState
  }

  function serializeTransport(transport) {
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    }
  }

  async function ensureMeetingRouter(roomId) {
    const normalizedRoomId = String(roomId || '').trim()
    if (!normalizedRoomId) {
      throw new Error('roomId is required to create an SFU router.')
    }

    const existing = roomsMedia.get(normalizedRoomId)
    if (existing) {
      return existing
    }

    const worker = await ensureWorker()
    const router = await worker.createRouter({
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {}
        }
      ]
    })

    const roomMedia = createRoomMediaState({ router })
    roomsMedia.set(normalizedRoomId, roomMedia)
    return roomMedia
  }

  async function getRouterRtpCapabilities(roomId) {
    const roomMedia = await ensureMeetingRouter(roomId)
    return roomMedia.router.rtpCapabilities
  }

  async function createSendTransport(roomId, peerId) {
    const roomMedia = await ensureMeetingRouter(roomId)
    const peerState = getOrCreatePeerState(roomMedia, peerId)

    peerState.sendTransport?.close()
    peerState.sendTransport = await roomMedia.router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS)

    return serializeTransport(peerState.sendTransport)
  }

  async function connectSendTransport(roomId, peerId, dtlsParameters) {
    const roomMedia = await ensureMeetingRouter(roomId)
    const peerState = getOrCreatePeerState(roomMedia, peerId)
    if (!peerState.sendTransport) {
      throw new Error('send transport does not exist for this peer.')
    }

    await peerState.sendTransport.connect({ dtlsParameters })
    return true
  }

  async function createRecvTransport(roomId, peerId) {
    const roomMedia = await ensureMeetingRouter(roomId)
    const peerState = getOrCreatePeerState(roomMedia, peerId)

    peerState.recvTransport?.close()
    peerState.recvTransport = await roomMedia.router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS)

    return serializeTransport(peerState.recvTransport)
  }

  async function connectRecvTransport(roomId, peerId, dtlsParameters) {
    const roomMedia = await ensureMeetingRouter(roomId)
    const peerState = getOrCreatePeerState(roomMedia, peerId)
    if (!peerState.recvTransport) {
      throw new Error('recv transport does not exist for this peer.')
    }

    await peerState.recvTransport.connect({ dtlsParameters })
    return true
  }

  function getPeerIdForProducer(roomMedia, producerId) {
    for (const [peerId, peerState] of roomMedia.peers.entries()) {
      if (peerState.producers.has(producerId)) {
        return peerId
      }
    }
    return ''
  }

  function serializeProducer(peerId, producer) {
    return {
      producerId: producer.id,
      peerId,
      kind: producer.kind,
      appData: producer.appData || {}
    }
  }

  async function produce(roomId, peerId, { kind, rtpParameters, appData = {} } = {}) {
    const roomMedia = await ensureMeetingRouter(roomId)
    const peerState = getOrCreatePeerState(roomMedia, peerId)
    if (!peerState.sendTransport) {
      throw new Error('send transport does not exist for this peer.')
    }

    const producer = await peerState.sendTransport.produce({
      kind,
      rtpParameters,
      appData: {
        ...appData,
        peerId
      }
    })

    peerState.producers.set(producer.id, producer)
    producer.on('transportclose', () => {
      peerState.producers.delete(producer.id)
    })
    producer.on('close', () => {
      peerState.producers.delete(producer.id)
    })

    return serializeProducer(peerId, producer)
  }

  async function consume(roomId, peerId, { producerId, rtpCapabilities } = {}) {
    const roomMedia = await ensureMeetingRouter(roomId)
    const peerState = getOrCreatePeerState(roomMedia, peerId)
    const normalizedProducerId = String(producerId || '')
    if (!peerState.recvTransport) {
      throw new Error('recv transport does not exist for this peer.')
    }
    if (!normalizedProducerId) {
      throw new Error('producerId is required.')
    }
    if (!roomMedia.router.canConsume({ producerId: normalizedProducerId, rtpCapabilities })) {
      throw new Error('router cannot consume this producer with the provided RTP capabilities.')
    }

    const producerPeerId = getPeerIdForProducer(roomMedia, normalizedProducerId)
    const producerPeerState = producerPeerId ? roomMedia.peers.get(producerPeerId) : null
    const producer = producerPeerState?.producers.get(normalizedProducerId)
    const consumer = await peerState.recvTransport.consume({
      producerId: normalizedProducerId,
      rtpCapabilities,
      paused: false
    })

    peerState.consumers.set(consumer.id, consumer)
    peerState.consumerProducerIds.set(consumer.id, normalizedProducerId)
    consumer.on('transportclose', () => {
      peerState.consumers.delete(consumer.id)
      peerState.consumerProducerIds.delete(consumer.id)
    })
    consumer.on('producerclose', () => {
      peerState.consumers.delete(consumer.id)
      peerState.consumerProducerIds.delete(consumer.id)
    })

    return {
      id: consumer.id,
      producerId: normalizedProducerId,
      producerPeerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      appData: producer?.appData || {}
    }
  }

  async function closeProducer(roomId, peerId, producerId) {
    const roomMedia = roomsMedia.get(String(roomId || '').trim())
    if (!roomMedia) {
      return false
    }

    const peerState = roomMedia.peers.get(String(peerId || '').trim())
    const producer = peerState?.producers.get(String(producerId || ''))
    if (!producer) {
      return false
    }

    producer.close()
    peerState.producers.delete(producer.id)
    return true
  }

  async function listProducers(roomId, excludePeerId = '') {
    const roomMedia = await ensureMeetingRouter(roomId)
    const producers = []
    const normalizedExcludePeerId = String(excludePeerId || '').trim()
    for (const [peerId, peerState] of roomMedia.peers.entries()) {
      if (peerId === normalizedExcludePeerId) {
        continue
      }
      for (const producer of peerState.producers.values()) {
        producers.push(serializeProducer(peerId, producer))
      }
    }
    return producers
  }

  async function closeParticipantMedia(roomId, peerId) {
    const roomMedia = roomsMedia.get(String(roomId || '').trim())
    if (!roomMedia) {
      return false
    }

    const peerState = roomMedia.peers.get(String(peerId || '').trim())
    if (!peerState) {
      return false
    }

    peerState.sendTransport?.close()
    peerState.recvTransport?.close()
    peerState.producers.forEach((producer) => producer.close())
    peerState.consumers.forEach((consumer) => consumer.close())
    peerState.consumerProducerIds.clear()
    roomMedia.peers.delete(String(peerId || '').trim())
    return true
  }

  async function closeRoomMedia(roomId) {
    const normalizedRoomId = String(roomId || '').trim()
    const roomMedia = roomsMedia.get(normalizedRoomId)
    if (!roomMedia) {
      return false
    }

    for (const peerState of roomMedia.peers.values()) {
      peerState.sendTransport?.close()
      peerState.recvTransport?.close()
      peerState.producers?.forEach?.((producer) => producer.close())
      peerState.consumers?.forEach?.((consumer) => consumer.close())
      peerState.consumerProducerIds?.clear?.()
    }

    roomMedia.router?.close()
    roomsMedia.delete(normalizedRoomId)
    if (roomsMedia.size === 0) {
      const worker = await workerPromise.catch(() => null)
      worker?.close?.()
      workerPromise = null
    }
    return true
  }

  return {
    ensureMeetingRouter,
    getRouterRtpCapabilities,
    createSendTransport,
    connectSendTransport,
    createRecvTransport,
    connectRecvTransport,
    produce,
    consume,
    closeProducer,
    listProducers,
    closeParticipantMedia,
    closeRoomMedia
  }
}

module.exports = {
  createMeetingSfuServer
}
