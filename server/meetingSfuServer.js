function createMeetingSfuServer() {
  const roomsMedia = new Map()
  let workerPromise = null
  const WEBRTC_TRANSPORT_OPTIONS = {
    listenInfos: [
      {
        protocol: 'udp',
        ip: '127.0.0.1'
      },
      {
        protocol: 'tcp',
        ip: '127.0.0.1'
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
    }

    return await workerPromise
  }

  function createRoomMediaState({ worker, router }) {
    return {
      worker,
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
        consumers: new Map()
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

    const roomMedia = createRoomMediaState({ worker, router })
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

  async function produce() {
    throw new Error('meetingSfuServer.produce is not implemented yet.')
  }

  async function consume() {
    throw new Error('meetingSfuServer.consume is not implemented yet.')
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
    }

    roomMedia.router?.close()
    roomMedia.worker?.close()
    roomsMedia.delete(normalizedRoomId)
    if (roomsMedia.size === 0) {
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
    closeParticipantMedia,
    closeRoomMedia
  }
}

module.exports = {
  createMeetingSfuServer
}
