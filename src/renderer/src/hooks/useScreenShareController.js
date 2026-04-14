import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isLikelyPermissionError, sleep } from '../utils/shareUtils'
import { removeMeetingRoom } from '../utils/meetingRoomsStorage'
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
const MAX_RECONNECT_ATTEMPTS = 6
const CHAT_DATA_CHANNEL_LABEL = 'meeting-chat'
const CHAT_CHUNK_SIZE = 16 * 1024
const SHARE_DEBUG_STORAGE_KEY = 'clip-share-debug'
const SHARE_DEBUG_PREFIX = '[share-debug]'

function isShareDebugEnabled() {
  if (!import.meta.env.DEV) {
    return false
  }

  try {
    return window.localStorage.getItem(SHARE_DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function logShareDebug(event, payload = {}) {
  if (!isShareDebugEnabled()) {
    return
  }
  const ts = new Date().toISOString()
  console.info(`${SHARE_DEBUG_PREFIX} ${ts} ${event}`, payload)
}

function createPeerConnection() {
  return new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS })
}

function createEmptySession() {
  return {
    roomId: '',
    role: '',
    peerId: '',
    token: '',
    wsUrl: ''
  }
}

function getReconnectDelay(attempt) {
  return Math.min(1000 * attempt, 4000)
}

function hasEnabledTrack(stream) {
  return Boolean(stream?.getTracks().some((track) => track.enabled))
}

function createTransferId(prefix = 'chat-transfer-') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID()}`
  }

  return `${prefix}${Math.random().toString(16).slice(2, 10)}`
}

export function useScreenShareController({
  isMeetingWindow,
  initialRoomId = '',
  initialSessionPayload = null,
  currentUserId = ''
}) {
  const [roomState, setRoomState] = useState('idle')
  const [shareState, setShareState] = useState('idle')
  const [connectionState, setConnectionState] = useState('idle')
  const [statusMessage, setStatusMessage] = useState('准备创建会议房间。')
  const [activeRoomId, setActiveRoomId] = useState(
    initialSessionPayload?.roomId || initialRoomId || ''
  )
  const [roomInfo, setRoomInfo] = useState(null)
  const [chatMessages, setChatMessages] = useState([])
  const [joinRoomId, setJoinRoomId] = useState(initialRoomId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerSources, setPickerSources] = useState([])
  const [pickerSelectedSourceId, setPickerSelectedSourceId] = useState('')
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [microphoneState, setMicrophoneState] = useState('idle')
  const [localPreviewStream, setLocalPreviewStream] = useState(null)
  const [remotePreviewStream, setRemotePreviewStream] = useState(null)

  const displayStreamRef = useRef(null)
  const microphoneStreamRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const hostPeerConnectionsRef = useRef(new Map())
  const hostChatChannelsRef = useRef(new Map())
  const viewerPeerConnectionRef = useRef(null)
  const viewerChatChannelRef = useRef(null)
  const hostRemoteAudioRef = useRef(new Map())
  const viewerPeerIdsRef = useRef(new Set())
  const deliveredChatMessageIdsRef = useRef(new Set())
  const incomingChatTransfersRef = useRef(new Map())
  const sessionRef = useRef(createEmptySession())
  const intentionalCloseRef = useRef(false)
  const reconnectTimerRef = useRef(null)
  const reconnectAttemptsRef = useRef(0)
  const microphoneRequestInFlightRef = useRef(null)
  const buildHostPeerConnectionRef = useRef(async () => null)
  const handleSocketMessageRef = useRef(async () => {})
  const initialSessionConsumedRef = useRef(false)
  const meetingSocketConnectedRef = useRef(false)
  const pendingSocketConnectRef = useRef(null)

  const isJoined = roomState === 'joined' && Boolean(roomInfo?.roomId)
  const isSharing = shareState === 'sharing'
  const isHost = roomInfo?.role === 'host'
  const isRoomOwner =
    (Boolean(currentUserId) &&
      (roomInfo?.ownerUserId === currentUserId ||
        initialSessionPayload?.ownerUserId === currentUserId ||
        initialSessionPayload?.currentUserId === currentUserId)) ||
    (isHost && !roomInfo?.ownerUserId && !initialSessionPayload?.ownerUserId)
  const isViewer = roomInfo?.role === 'viewer'
  const canLeaveMeeting = Boolean(
    roomInfo?.roomId || activeRoomId || initialRoomId || initialSessionPayload?.roomId
  )
  const canManageShare = (isHost || isRoomOwner) && canLeaveMeeting
  const currentPeerId =
    roomInfo?.peerId || sessionRef.current.peerId || initialSessionPayload?.peerId || ''

  const getOwnedRoomIdForCleanup = useCallback(() => {
    if (!isRoomOwner) {
      return ''
    }

    return (
      activeRoomId ||
      sessionRef.current.roomId ||
      roomInfo?.roomId ||
      initialSessionPayload?.roomId ||
      ''
    )
  }, [activeRoomId, initialSessionPayload?.roomId, isRoomOwner, roomInfo?.roomId])

  const connectionLabel = useMemo(() => {
    if (connectionState === 'connecting') return '连接中'
    if (connectionState === 'connected') return '已连接'
    if (connectionState === 'reconnecting') return '重连中'
    if (connectionState === 'failed') return '连接失败'
    return '--'
  }, [connectionState])

  const applyStreamToVideo = useCallback((videoEl, stream) => {
    if (!videoEl) {
      return
    }
    videoEl.srcObject = stream || null
    if (stream) {
      videoEl.play().catch(() => {})
    }
  }, [])

  const syncLocalPreview = useCallback(() => {
    const stream = displayStreamRef.current || null
    setLocalPreviewStream(displayStreamRef.current || null)
    logShareDebug('syncLocalPreview', {
      hasStream: Boolean(stream),
      trackCount: stream?.getTracks?.().length || 0,
      hasVideoEl: Boolean(localVideoRef.current)
    })
    applyStreamToVideo(localVideoRef.current, stream)
  }, [applyStreamToVideo])

  const syncRemotePreview = useCallback(
    (stream = null) => {
      remoteStreamRef.current = stream
      setRemotePreviewStream(stream)
      logShareDebug('syncRemotePreview', {
        hasStream: Boolean(stream),
        trackCount: stream?.getTracks?.().length || 0,
        hasVideoEl: Boolean(remoteVideoRef.current)
      })
      applyStreamToVideo(remoteVideoRef.current, stream)
    },
    [applyStreamToVideo]
  )

  useEffect(() => {
    // Stage area switches between avatar wall and video preview by state.
    // Re-bind streams after that switch to avoid losing srcObject on remount.
    logShareDebug('shareVisibilityChanged', {
      isSharing,
      shareActive: Boolean(roomInfo?.shareActive),
      hasDisplayStream: Boolean(displayStreamRef.current),
      hasRemoteStream: Boolean(remoteStreamRef.current)
    })
    if (displayStreamRef.current) {
      syncLocalPreview()
    }

    if (remoteStreamRef.current) {
      syncRemotePreview(remoteStreamRef.current)
    }
  }, [isSharing, roomInfo?.shareActive, syncLocalPreview, syncRemotePreview])

  const sendSocketMessage = useCallback((payload) => {
    if (!meetingSocketConnectedRef.current) {
      return false
    }

    const sender = window.api?.sendScreenShareMeetingMessage
    if (typeof sender !== 'function') {
      return false
    }

    Promise.resolve(sender(payload)).catch(() => {})
    return true
  }, [])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const appendChatMessage = useCallback((message) => {
    if (!message?.messageId || deliveredChatMessageIdsRef.current.has(message.messageId)) {
      return
    }

    deliveredChatMessageIdsRef.current.add(message.messageId)
    setChatMessages((previous) => [...previous, message])
  }, [])

  const sendDataChannelPayload = useCallback((channel, payload) => {
    if (!channel || channel.readyState !== 'open') {
      return false
    }

    const serialized = JSON.stringify(payload || {})
    const totalChunks = Math.max(1, Math.ceil(serialized.length / CHAT_CHUNK_SIZE))
    const transferId = createTransferId()

    channel.send(JSON.stringify({ type: 'chat-transfer-meta', transferId, totalChunks }))
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * CHAT_CHUNK_SIZE
      channel.send(
        JSON.stringify({
          type: 'chat-transfer-chunk',
          transferId,
          index,
          chunk: serialized.slice(start, start + CHAT_CHUNK_SIZE)
        })
      )
    }

    return true
  }, [])

  const relayChatMessageFromHost = useCallback(
    (message, excludePeerId = '') => {
      for (const [peerId, channel] of hostChatChannelsRef.current.entries()) {
        if (peerId === excludePeerId) {
          continue
        }
        sendDataChannelPayload(channel, {
          type: 'chat-message',
          message
        })
      }
    },
    [sendDataChannelPayload]
  )

  const handleDataChannelPayload = useCallback(
    (payload, sourcePeerId = '') => {
      if (payload?.type !== 'chat-message' || !payload?.message) {
        return
      }

      const message = payload.message
      appendChatMessage(message)

      if (sessionRef.current.role === 'host') {
        relayChatMessageFromHost(message, sourcePeerId)
      }
    },
    [appendChatMessage, relayChatMessageFromHost]
  )

  const setupChatDataChannel = useCallback(
    (channel, peerId = '') => {
      if (!channel) {
        return null
      }

      channel.onmessage = (event) => {
        let packet = null
        try {
          packet = JSON.parse(String(event.data || ''))
        } catch {
          return
        }

        if (packet.type === 'chat-transfer-meta') {
          incomingChatTransfersRef.current.set(`${peerId}:${packet.transferId}`, {
            totalChunks: Number(packet.totalChunks || 0),
            chunks: []
          })
          return
        }

        if (packet.type === 'chat-transfer-chunk') {
          const key = `${peerId}:${packet.transferId}`
          const transfer = incomingChatTransfersRef.current.get(key)
          if (!transfer) {
            return
          }

          transfer.chunks[packet.index] = String(packet.chunk || '')
          const receivedChunks = transfer.chunks.filter(Boolean).length
          if (receivedChunks < transfer.totalChunks) {
            return
          }

          incomingChatTransfersRef.current.delete(key)

          try {
            const payload = JSON.parse(transfer.chunks.join(''))
            handleDataChannelPayload(payload, peerId)
          } catch {
            return
          }
          return
        }

        handleDataChannelPayload(packet, peerId)
      }

      channel.onclose = () => {
        if (sessionRef.current.role === 'host') {
          hostChatChannelsRef.current.delete(peerId)
        } else if (viewerChatChannelRef.current === channel) {
          viewerChatChannelRef.current = null
        }
      }

      channel.onerror = () => {}
      return channel
    },
    [handleDataChannelPayload]
  )

  const cleanupRemoteAudio = useCallback((peerId) => {
    const audio = hostRemoteAudioRef.current.get(peerId)
    if (!audio) {
      return
    }
    audio.pause()
    audio.srcObject = null
    hostRemoteAudioRef.current.delete(peerId)
  }, [])

  const cleanupAllRemoteAudio = useCallback(() => {
    for (const peerId of hostRemoteAudioRef.current.keys()) {
      cleanupRemoteAudio(peerId)
    }
  }, [cleanupRemoteAudio])

  const stopDisplayStream = useCallback(() => {
    if (!displayStreamRef.current) {
      return
    }
    displayStreamRef.current.getTracks().forEach((track) => track.stop())
    displayStreamRef.current = null
    syncLocalPreview()
  }, [syncLocalPreview])

  const stopMicrophoneStream = useCallback(() => {
    if (!microphoneStreamRef.current) {
      return
    }
    microphoneStreamRef.current.getTracks().forEach((track) => track.stop())
    microphoneStreamRef.current = null
    setMicrophoneEnabled(false)
    setMicrophoneState('idle')
  }, [])

  const closeHostPeerConnections = useCallback(() => {
    for (const [peerId, peerConnection] of hostPeerConnectionsRef.current.entries()) {
      peerConnection.close()
      hostChatChannelsRef.current.delete(peerId)
      cleanupRemoteAudio(peerId)
    }
    hostPeerConnectionsRef.current.clear()
  }, [cleanupRemoteAudio])

  const closeViewerPeerConnection = useCallback(() => {
    if (viewerPeerConnectionRef.current) {
      viewerPeerConnectionRef.current.close()
      viewerPeerConnectionRef.current = null
    }
    viewerChatChannelRef.current = null
    syncRemotePreview(null)
  }, [syncRemotePreview])

  const getAudioTracks = useCallback(() => {
    return microphoneStreamRef.current?.getAudioTracks() || []
  }, [])

  const addLocalAudioTracks = useCallback(
    (peerConnection) => {
      for (const track of getAudioTracks()) {
        peerConnection.addTrack(track, microphoneStreamRef.current)
      }
    },
    [getAudioTracks]
  )

  const updateRoomInfo = useCallback((room, options = {}) => {
    setRoomInfo((previous) => {
      const role = options.role || sessionRef.current.role || room?.role || previous?.role || 'host'

      return {
        ...(previous || {}),
        ...(room || {}),
        participants: Array.isArray(room?.participants)
          ? room.participants
          : previous?.participants || [],
        peerId: sessionRef.current.peerId || previous?.peerId || room?.peerId || '',
        role
      }
    })
  }, [])

  const closeMeetingWindow = useCallback(() => {
    if (!isMeetingWindow) {
      return
    }

    window.setTimeout(() => {
      window.close()
    }, 0)
  }, [isMeetingWindow])

  const rebuildHostPeerConnections = useCallback(async () => {
    if (sessionRef.current.role !== 'host' || connectionState !== 'connected') {
      return
    }

    for (const viewerPeerId of viewerPeerIdsRef.current) {
      await buildHostPeerConnectionRef.current(viewerPeerId)
    }
  }, [connectionState])

  const resetShareSession = useCallback(
    ({ preserveJoinRoomId = false } = {}) => {
      clearReconnectTimer()
      intentionalCloseRef.current = true
      closeHostPeerConnections()
      closeViewerPeerConnection()
      cleanupAllRemoteAudio()
      stopDisplayStream()
      stopMicrophoneStream()
      viewerPeerIdsRef.current = new Set()
      hostChatChannelsRef.current.clear()
      viewerChatChannelRef.current = null
      deliveredChatMessageIdsRef.current.clear()
      incomingChatTransfersRef.current.clear()
      reconnectAttemptsRef.current = 0
      meetingSocketConnectedRef.current = false
      pendingSocketConnectRef.current = null
      const disconnectSocket = window.api?.disconnectScreenShareMeetingSocket
      if (typeof disconnectSocket === 'function') {
        Promise.resolve(
          disconnectSocket({
            sendLeave: false,
            suppressCloseEvent: true
          })
        ).catch(() => {})
      }
      sessionRef.current = createEmptySession()
      setActiveRoomId('')
      setRoomInfo(null)
      setChatMessages([])
      setRoomState('idle')
      setShareState('idle')
      setConnectionState('idle')
      setLocalPreviewStream(null)
      setRemotePreviewStream(null)
      setPickerOpen(false)
      setPickerLoading(false)
      setPickerSources([])
      setPickerSelectedSourceId('')
      if (!preserveJoinRoomId) {
        setJoinRoomId('')
      }
    },
    [
      cleanupAllRemoteAudio,
      clearReconnectTimer,
      closeHostPeerConnections,
      closeViewerPeerConnection,
      stopDisplayStream,
      stopMicrophoneStream
    ]
  )

  const announceShareState = useCallback(
    (active) => {
      sendSocketMessage({ type: 'share-state', active })
    },
    [sendSocketMessage]
  )

  const announceAudioState = useCallback(
    (active) => {
      sendSocketMessage({ type: 'audio-state', active })
    },
    [sendSocketMessage]
  )

  const resolveOutgoingSender = useCallback(() => {
    const inferredHost =
      sessionRef.current.peerId === 'host' ||
      roomInfo?.peerId === 'host' ||
      initialSessionPayload?.peerId === 'host' ||
      isRoomOwner

    const nextRole =
      sessionRef.current.role ||
      roomInfo?.role ||
      initialSessionPayload?.role ||
      (inferredHost ? 'host' : 'viewer')

    const role = nextRole === 'host' ? 'host' : 'viewer'
    const senderPeerId =
      sessionRef.current.peerId ||
      roomInfo?.peerId ||
      initialSessionPayload?.peerId ||
      (role === 'host' ? 'host' : `viewer-${currentUserId || 'local'}`)

    return {
      role,
      senderPeerId
    }
  }, [
    currentUserId,
    initialSessionPayload?.peerId,
    initialSessionPayload?.role,
    isRoomOwner,
    roomInfo?.peerId,
    roomInfo?.role
  ])

  const sendChatText = useCallback(
    async (text) => {
      const nextText = String(text || '').trim()
      if (!nextText) {
        return false
      }

      if (!canLeaveMeeting) {
        setStatusMessage('当前不在有效会议房间内，无法发送消息。')
        return false
      }

      const sender = resolveOutgoingSender()
      const message = {
        messageId: createTransferId('msg-'),
        roomId: roomInfo?.roomId || activeRoomId || '',
        senderPeerId: sender.senderPeerId,
        senderRole: sender.role,
        kind: 'text',
        text: nextText,
        imageDataUrl: '',
        createdAt: Date.now()
      }
      appendChatMessage(message)

      const role = sender.role
      let sent = false
      if (role === 'host') {
        relayChatMessageFromHost(message)
        sent = true
      } else {
        sent = sendDataChannelPayload(viewerChatChannelRef.current, {
          type: 'chat-message',
          message
        })
      }

      if (!sent) {
        setStatusMessage('会议连接尚未恢复，暂时无法发送消息。')
      }

      return sent
    },
    [
      activeRoomId,
      appendChatMessage,
      canLeaveMeeting,
      relayChatMessageFromHost,
      roomInfo?.roomId,
      resolveOutgoingSender,
      sendDataChannelPayload
    ]
  )

  const sendChatImage = useCallback(
    async (file) => {
      if (!(file instanceof File)) {
        return false
      }

      if (!canLeaveMeeting) {
        setStatusMessage('当前不在有效会议房间内，无法发送图片。')
        return false
      }

      if (!file.type.startsWith('image/')) {
        setStatusMessage('仅支持发送图片文件。')
        return false
      }

      if (file.size > 2 * 1024 * 1024) {
        setStatusMessage('图片不能超过 2MB。')
        return false
      }

      const imageDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取图片失败。'))
        reader.readAsDataURL(file)
      }).catch((error) => {
        setStatusMessage(error?.message || '读取图片失败。')
        return ''
      })

      if (!imageDataUrl) {
        return false
      }

      const sender = resolveOutgoingSender()
      const message = {
        messageId: createTransferId('msg-'),
        roomId: roomInfo?.roomId || activeRoomId || '',
        senderPeerId: sender.senderPeerId,
        senderRole: sender.role,
        kind: 'image',
        text: '',
        imageDataUrl,
        createdAt: Date.now()
      }
      appendChatMessage(message)

      const role = sender.role
      let sent = false
      if (role === 'host') {
        relayChatMessageFromHost(message)
        sent = true
      } else {
        sent = sendDataChannelPayload(viewerChatChannelRef.current, {
          type: 'chat-message',
          message
        })
      }

      if (!sent) {
        setStatusMessage('会议连接尚未恢复，暂时无法发送图片。')
      }

      return sent
    },
    [
      activeRoomId,
      appendChatMessage,
      canLeaveMeeting,
      relayChatMessageFromHost,
      roomInfo?.roomId,
      resolveOutgoingSender,
      sendDataChannelPayload
    ]
  )

  const buildHostPeerConnection = useCallback(
    async (viewerPeerId) => {
      if (!viewerPeerId || !meetingSocketConnectedRef.current) {
        return null
      }

      const existing = hostPeerConnectionsRef.current.get(viewerPeerId)
      if (existing) {
        existing.close()
        hostPeerConnectionsRef.current.delete(viewerPeerId)
        cleanupRemoteAudio(viewerPeerId)
      }

      const peerConnection = createPeerConnection()
      hostPeerConnectionsRef.current.set(viewerPeerId, peerConnection)
      const chatChannel = setupChatDataChannel(
        peerConnection.createDataChannel(CHAT_DATA_CHANNEL_LABEL),
        viewerPeerId
      )
      hostChatChannelsRef.current.set(viewerPeerId, chatChannel)

      peerConnection.onicecandidate = (event) => {
        if (!event.candidate) {
          return
        }
        sendSocketMessage({
          type: 'ice-candidate',
          targetPeerId: viewerPeerId,
          payload: event.candidate
        })
      }

      peerConnection.ontrack = (event) => {
        const stream = event.streams?.[0]
        if (!stream) {
          return
        }

        const audio = hostRemoteAudioRef.current.get(viewerPeerId) || new Audio()
        audio.autoplay = true
        audio.srcObject = stream
        audio.play().catch(() => {})
        hostRemoteAudioRef.current.set(viewerPeerId, audio)
      }

      peerConnection.onconnectionstatechange = () => {
        if (
          peerConnection.connectionState === 'failed' ||
          peerConnection.connectionState === 'closed' ||
          peerConnection.connectionState === 'disconnected'
        ) {
          peerConnection.close()
          hostPeerConnectionsRef.current.delete(viewerPeerId)
          hostChatChannelsRef.current.delete(viewerPeerId)
          cleanupRemoteAudio(viewerPeerId)
        }
      }

      addLocalAudioTracks(peerConnection)
      if (displayStreamRef.current) {
        for (const track of displayStreamRef.current.getVideoTracks()) {
          peerConnection.addTrack(track, displayStreamRef.current)
        }
      }

      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      sendSocketMessage({
        type: 'offer',
        targetPeerId: viewerPeerId,
        payload: offer
      })

      return peerConnection
    },
    [addLocalAudioTracks, cleanupRemoteAudio, sendSocketMessage, setupChatDataChannel]
  )

  useEffect(() => {
    buildHostPeerConnectionRef.current = buildHostPeerConnection
  }, [buildHostPeerConnection])

  const createViewerPeerConnection = useCallback(() => {
    if (viewerPeerConnectionRef.current) {
      viewerPeerConnectionRef.current.close()
      viewerPeerConnectionRef.current = null
    }

    const peerConnection = createPeerConnection()
    viewerPeerConnectionRef.current = peerConnection

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return
      }
      sendSocketMessage({
        type: 'ice-candidate',
        targetPeerId: 'host',
        payload: event.candidate
      })
    }

    peerConnection.ontrack = (event) => {
      const stream = event.streams?.[0]
      if (stream) {
        syncRemotePreview(stream)
      }
    }

    peerConnection.ondatachannel = (event) => {
      viewerChatChannelRef.current = setupChatDataChannel(event.channel, 'host')
    }

    peerConnection.onconnectionstatechange = () => {
      if (
        peerConnection.connectionState === 'failed' ||
        peerConnection.connectionState === 'closed' ||
        peerConnection.connectionState === 'disconnected'
      ) {
        syncRemotePreview(null)
        viewerChatChannelRef.current = null
      }
    }

    addLocalAudioTracks(peerConnection)
    return peerConnection
  }, [addLocalAudioTracks, sendSocketMessage, setupChatDataChannel, syncRemotePreview])

  const ensureMicrophoneStream = useCallback(
    async ({ silent = false } = {}) => {
      if (microphoneStreamRef.current) {
        const tracks = microphoneStreamRef.current.getAudioTracks()
        tracks.forEach((track) => {
          track.enabled = true
        })
        setMicrophoneEnabled(true)
        setMicrophoneState('active')
        announceAudioState(true)
        return microphoneStreamRef.current
      }

      if (microphoneRequestInFlightRef.current) {
        return await microphoneRequestInFlightRef.current
      }

      setMicrophoneState('requesting')
      const request = window.navigator.mediaDevices
        .getUserMedia({ audio: true, video: false })
        .then((stream) => {
          microphoneStreamRef.current = stream
          stream.getAudioTracks().forEach((track) => {
            track.enabled = true
          })
          setMicrophoneEnabled(true)
          setMicrophoneState('active')
          announceAudioState(true)
          if (!silent) {
            setStatusMessage((previous) => {
              if (previous.includes('会议')) {
                return previous
              }
              return '麦克风已开启，创建或加入会议房间后即可语音通话。'
            })
          }
          return stream
        })
        .catch((error) => {
          setMicrophoneEnabled(false)
          setMicrophoneState('blocked')
          if (!silent) {
            if (isLikelyPermissionError(error)) {
              setStatusMessage(
                `无法开启麦克风：${error?.message || '权限不足。'} 请在系统设置里允许麦克风权限后重试。`
              )
            } else {
              setStatusMessage(`无法开启麦克风：${error?.message || '未知错误。'}`)
            }
          }
          throw error
        })
        .finally(() => {
          microphoneRequestInFlightRef.current = null
        })

      microphoneRequestInFlightRef.current = request
      return await request
    },
    [announceAudioState]
  )

  const toggleMicrophone = useCallback(async () => {
    if (!microphoneStreamRef.current) {
      try {
        await ensureMicrophoneStream()
      } catch {
        return
      }

      if (isJoined && connectionState === 'connected') {
        if (isHost) {
          await rebuildHostPeerConnections()
        } else if (isViewer) {
          sendSocketMessage({ type: 'renegotiate-request', targetPeerId: 'host' })
        }
      }
      return
    }

    const nextEnabled = !hasEnabledTrack(microphoneStreamRef.current)
    microphoneStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = nextEnabled
    })
    setMicrophoneEnabled(nextEnabled)
    setMicrophoneState(nextEnabled ? 'active' : 'muted')
    announceAudioState(nextEnabled)
    setStatusMessage(nextEnabled ? '麦克风已开启。' : '麦克风已关闭。')
  }, [
    announceAudioState,
    connectionState,
    ensureMicrophoneStream,
    isHost,
    isJoined,
    isViewer,
    rebuildHostPeerConnections,
    sendSocketMessage
  ])

  const handleSocketMessage = useCallback(
    async (message) => {
      if (message.type === 'welcome' || message.type === 'room-state') {
        const room = message.room || {}
        updateRoomInfo(room)

        if (sessionRef.current.role === 'viewer') {
          if (!room.hostPresent) {
            closeViewerPeerConnection()
            setShareState('idle')
            setStatusMessage('主持人暂时离线，等待重新连接。')
            return
          }

          setShareState(room.shareActive ? 'sharing' : 'idle')
          if (!room.shareActive && connectionState === 'connected') {
            setStatusMessage('已加入会议，当前只有语音通话，等待主持人开始桌面共享。')
          }
        }
        return
      }

      if (message.type === 'room-closed') {
        intentionalCloseRef.current = true
        if (message.roomId) {
          removeMeetingRoom(message.roomId)
        }
        resetShareSession({ preserveJoinRoomId: true })
        setStatusMessage(message.message || '主持人已离开会议，房间已关闭。')
        closeMeetingWindow()
        return
      }

      if (message.type === 'chat-message' && message.message) {
        setChatMessages((previous) => [...previous, message.message])
        return
      }

      if (message.type === 'peer-join') {
        viewerPeerIdsRef.current.add(message.peerId)
        await buildHostPeerConnection(message.peerId)
        return
      }

      if (message.type === 'peer-leave') {
        viewerPeerIdsRef.current.delete(message.peerId)
        const peerConnection = hostPeerConnectionsRef.current.get(message.peerId)
        if (peerConnection) {
          peerConnection.close()
          hostPeerConnectionsRef.current.delete(message.peerId)
        }
        cleanupRemoteAudio(message.peerId)
        return
      }

      if (message.type === 'share-started') {
        if (sessionRef.current.role === 'viewer') {
          setShareState('sharing')
          setStatusMessage('主持人已开始桌面共享，正在接收画面...')
        }
        return
      }

      if (message.type === 'share-stopped') {
        if (sessionRef.current.role === 'viewer') {
          setShareState('idle')
          setStatusMessage('主持人已停止桌面共享，语音通话继续。')
        }
        return
      }

      if (message.type === 'renegotiate-request' && sessionRef.current.role === 'host') {
        await buildHostPeerConnection(message.fromPeerId)
        return
      }

      if (message.type === 'offer' && sessionRef.current.role === 'viewer') {
        const peerConnection = createViewerPeerConnection()
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.payload))
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        sendSocketMessage({
          type: 'answer',
          targetPeerId: 'host',
          payload: answer
        })
        setStatusMessage(
          roomInfo?.shareActive ? '正在接收共享画面...' : '已接入会议语音，等待桌面共享。'
        )
        return
      }

      if (message.type === 'answer' && sessionRef.current.role === 'host') {
        const peerConnection = hostPeerConnectionsRef.current.get(message.fromPeerId)
        if (peerConnection) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(message.payload))
        }
        return
      }

      if (message.type === 'ice-candidate') {
        if (!message.payload) {
          return
        }

        if (sessionRef.current.role === 'host') {
          const peerConnection = hostPeerConnectionsRef.current.get(message.fromPeerId)
          if (peerConnection) {
            await peerConnection
              .addIceCandidate(new RTCIceCandidate(message.payload))
              .catch(() => {})
          }
          return
        }

        const peerConnection = viewerPeerConnectionRef.current || createViewerPeerConnection()
        await peerConnection.addIceCandidate(new RTCIceCandidate(message.payload)).catch(() => {})
      }
    },
    [
      buildHostPeerConnection,
      cleanupRemoteAudio,
      closeViewerPeerConnection,
      connectionState,
      createViewerPeerConnection,
      closeMeetingWindow,
      roomInfo?.shareActive,
      resetShareSession,
      sendSocketMessage,
      updateRoomInfo
    ]
  )

  useEffect(() => {
    handleSocketMessageRef.current = handleSocketMessage
  }, [handleSocketMessage])

  const connectSocket = useCallback(
    async ({ roomId, role, peerId, token, wsUrl }, options = {}) => {
      const reconnect = Boolean(options.reconnect)
      const connector = window.api?.connectScreenShareMeetingSocket

      if (typeof connector !== 'function') {
        throw new Error('会议连接接口不可用。')
      }

      if (pendingSocketConnectRef.current?.reject) {
        pendingSocketConnectRef.current.reject(new Error('会议连接已被新的请求替换。'))
        pendingSocketConnectRef.current = null
      }

      intentionalCloseRef.current = false
      meetingSocketConnectedRef.current = false
      setConnectionState(reconnect ? 'reconnecting' : 'connecting')

      const welcomePromise = new Promise((resolve, reject) => {
        pendingSocketConnectRef.current = {
          resolve,
          reject,
          reconnect,
          payload: { roomId, role, peerId, token, wsUrl }
        }
      })

      const result = await connector({ roomId, role, peerId, token, wsUrl })
      if (!result?.ok) {
        pendingSocketConnectRef.current = null
        throw new Error(result?.message || '连接会议房间失败。')
      }

      return await welcomePromise
    },
    []
  )

  useEffect(() => {
    const subscribe = window.api?.onScreenShareMeetingSocketEvent
    if (typeof subscribe !== 'function') {
      return undefined
    }

    const stopListening = subscribe((event) => {
      if (event?.kind === 'message') {
        const message = event.message || {}

        if (message.type === 'welcome') {
          const pendingConnect = pendingSocketConnectRef.current
          const nextSession = pendingConnect?.payload || sessionRef.current
          const reconnect = Boolean(pendingConnect?.reconnect)
          const role = nextSession.role || message.role || 'host'

          meetingSocketConnectedRef.current = true
          sessionRef.current = nextSession
          setActiveRoomId(nextSession.roomId || message.room?.roomId || '')
          reconnectAttemptsRef.current = 0

          if (Array.isArray(message.viewerPeerIds) && role === 'host') {
            viewerPeerIdsRef.current = new Set(message.viewerPeerIds)
          }

          updateRoomInfo(message.room || {}, { role })
          setRoomState('joined')
          setConnectionState('connected')
          setShareState(
            displayStreamRef.current ? 'sharing' : message.room?.shareActive ? 'sharing' : 'idle'
          )

          if (role === 'host') {
            setStatusMessage(
              reconnect
                ? displayStreamRef.current
                  ? '会议已重新连接，正在恢复静音语音链路和桌面共享。'
                  : '会议已重新连接，当前默认静音。'
                : '会议房间已创建，语音链路已建立，当前默认静音。'
            )
          } else {
            setStatusMessage(
              reconnect
                ? message.room?.shareActive
                  ? '已重新加入会议，正在恢复共享画面，当前默认静音。'
                  : '已重新加入会议，当前默认静音。'
                : message.room?.shareActive
                  ? '已加入会议，正在接入共享画面，当前默认静音。'
                  : '已加入会议，当前默认静音。'
            )
          }

          pendingConnect?.resolve?.(message)
          pendingSocketConnectRef.current = null

          if (role === 'host' && (microphoneStreamRef.current || displayStreamRef.current)) {
            Promise.resolve().then(async () => {
              for (const viewerPeerId of viewerPeerIdsRef.current) {
                await buildHostPeerConnectionRef.current(viewerPeerId)
              }
              if (displayStreamRef.current) {
                announceShareState(true)
                setShareState('sharing')
              }
              announceAudioState(hasEnabledTrack(microphoneStreamRef.current))
            })
          }
        }

        void handleSocketMessageRef.current(message)
        return
      }

      if (event?.kind !== 'close') {
        return
      }

      const pendingConnect = pendingSocketConnectRef.current
      const nextSession = pendingConnect?.payload || sessionRef.current
      const role = nextSession.role || sessionRef.current.role
      const closeReason = event.closeReason || 'Room socket closed before ready.'

      meetingSocketConnectedRef.current = false
      closeHostPeerConnections()
      closeViewerPeerConnection()

      if (pendingConnect) {
        pendingConnect.reject(new Error(closeReason))
        pendingSocketConnectRef.current = null
      }

      if (intentionalCloseRef.current) {
        return
      }

      if (role === 'viewer') {
        setShareState('idle')
      }

      if (!event.reconnectable) {
        if (role === 'host') {
          stopDisplayStream()
          setShareState('idle')
        }
        setConnectionState('failed')
        setStatusMessage(closeReason)
        closeMeetingWindow()
        return
      }

      const nextAttempt = reconnectAttemptsRef.current + 1
      if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
        if (role === 'host') {
          stopDisplayStream()
          setShareState('idle')
        }
        setConnectionState('failed')
        setStatusMessage(
          role === 'host'
            ? '会议连接已断开，多次重连失败，请重新进入会议。'
            : '会议连接已断开，多次重连失败，请重新加入会议。'
        )
        return
      }

      reconnectAttemptsRef.current = nextAttempt
      setRoomState('joined')
      setConnectionState('reconnecting')
      setStatusMessage(
        role === 'host'
          ? displayStreamRef.current
            ? `会议连接中断，正在重连并恢复语音与桌面共享（第 ${nextAttempt} 次）...`
            : `会议连接中断，正在重连并恢复语音通话（第 ${nextAttempt} 次）...`
          : `会议连接中断，正在重新加入房间（第 ${nextAttempt} 次）...`
      )

      clearReconnectTimer()
      reconnectTimerRef.current = window.setTimeout(() => {
        void connectSocket(nextSession, { reconnect: true }).catch(() => {})
      }, getReconnectDelay(nextAttempt))
    })

    return () => {
      stopListening?.()
    }
  }, [
    announceAudioState,
    announceShareState,
    clearReconnectTimer,
    closeHostPeerConnections,
    closeMeetingWindow,
    closeViewerPeerConnection,
    connectSocket,
    stopDisplayStream,
    updateRoomInfo
  ])

  const createRoom = useCallback(async () => {
    clearReconnectTimer()
    setRoomState('creating')
    setConnectionState('connecting')
    setStatusMessage('正在创建会议房间...')

    try {
      if (typeof window.api?.createScreenShareRoom !== 'function') {
        throw new Error('共享服务不可用。')
      }

      const payload = await window.api.createScreenShareRoom({ userId: currentUserId })
      if (!payload?.ok) {
        throw new Error(payload?.message || '创建会议房间失败。')
      }

      setActiveRoomId(payload.roomId)
      await connectSocket(payload)
      return payload
    } catch (error) {
      setRoomState('idle')
      setConnectionState('failed')
      setStatusMessage(error?.message || '创建会议房间失败。')
      return null
    }
  }, [clearReconnectTimer, connectSocket, currentUserId])

  const joinRoom = useCallback(async () => {
    const normalizedRoomId = joinRoomId.trim()
    if (!normalizedRoomId) {
      setStatusMessage('请输入房间号。')
      return null
    }

    clearReconnectTimer()
    setRoomState('joining')
    setConnectionState('connecting')
    setStatusMessage('正在加入会议房间...')

    try {
      if (typeof window.api?.joinScreenShareRoom !== 'function') {
        throw new Error('共享服务不可用。')
      }

      const payload = await window.api.joinScreenShareRoom({
        roomId: normalizedRoomId,
        userId: currentUserId
      })
      if (!payload?.ok) {
        throw new Error(payload?.message || '加入会议房间失败。')
      }

      setActiveRoomId(payload.roomId)
      await connectSocket(payload)
      return payload
    } catch (error) {
      setRoomState('idle')
      setConnectionState('failed')
      setStatusMessage(error?.message || '加入会议房间失败。')
      return null
    }
  }, [clearReconnectTimer, connectSocket, currentUserId, joinRoomId])

  const exitMeeting = useCallback(async () => {
    const ownedRoomId = getOwnedRoomIdForCleanup()
    if (ownedRoomId) {
      removeMeetingRoom(ownedRoomId)
    }

    const disconnectSocket = window.api?.disconnectScreenShareMeetingSocket
    if (typeof disconnectSocket === 'function') {
      await disconnectSocket({
        sendLeave: true,
        suppressCloseEvent: true
      }).catch(() => {})
    }

    resetShareSession({ preserveJoinRoomId: true })
    setStatusMessage(ownedRoomId ? '已关闭会议房间。' : '已离开会议房间。')
    closeMeetingWindow()
  }, [closeMeetingWindow, getOwnedRoomIdForCleanup, resetShareSession])

  const leaveRoom = useCallback(async () => {
    await exitMeeting()
  }, [exitMeeting])

  const loadShareSources = useCallback(async () => {
    setPickerLoading(true)
    setPickerSources([])
    const minimumLoading = sleep(1500)
    logShareDebug('loadShareSources:start')

    try {
      const getter = window.api?.getScreenShareSources
      if (typeof getter !== 'function') {
        throw new Error('共享源 API 不可用。')
      }

      const result = await getter()
      await minimumLoading
      if (!result?.ok) {
        throw new Error(result?.message || '读取共享源失败。')
      }

      const sources = Array.isArray(result.sources) ? result.sources : []
      setPickerSources(sources)
      setPickerSelectedSourceId(
        sources.find((item) => item.type === 'screen')?.id || sources[0]?.id || ''
      )
      logShareDebug('loadShareSources:success', {
        count: sources.length,
        selectedSourceId: sources.find((item) => item.type === 'screen')?.id || sources[0]?.id || ''
      })
    } catch (error) {
      await minimumLoading
      logShareDebug('loadShareSources:error', {
        message: error instanceof Error ? error.message : String(error)
      })
      setStatusMessage(error?.message || '读取共享源失败。')
    } finally {
      setPickerLoading(false)
    }
  }, [])

  const openSourcePicker = useCallback(async () => {
    logShareDebug('openSourcePicker:click', {
      canManageShare,
      canLeaveMeeting
    })
    if (!canManageShare) {
      return
    }
    setPickerOpen(true)
    await loadShareSources()
  }, [canLeaveMeeting, canManageShare, loadShareSources])

  const stopSharing = useCallback(async () => {
    announceShareState(false)
    stopDisplayStream()
    setShareState('idle')
    setStatusMessage('已停止桌面共享，语音通话继续。')

    if (isHost && connectionState === 'connected') {
      await rebuildHostPeerConnections()
    }
  }, [announceShareState, connectionState, isHost, rebuildHostPeerConnections, stopDisplayStream])

  const beginShareWithSource = useCallback(async () => {
    logShareDebug('beginShareWithSource:click', {
      selectedSourceId: pickerSelectedSourceId,
      canManageShare,
      connectionState
    })
    if (!pickerSelectedSourceId || !canManageShare) {
      return
    }

    setShareState('starting')
    setStatusMessage('正在请求桌面共享权限...')

    try {
      const setter = window.api?.setScreenShareSource
      if (typeof setter === 'function') {
        const result = await setter({ sourceId: pickerSelectedSourceId })
        logShareDebug('setScreenShareSource:result', result || {})
        if (!result?.ok) {
          throw new Error(result?.message || '设置共享源失败。')
        }
      }

      logShareDebug('getDisplayMedia:request', {
        sourceId: pickerSelectedSourceId
      })
      const stream = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      })
      logShareDebug('getDisplayMedia:success', {
        streamId: stream?.id || '',
        trackCount: stream?.getTracks?.().length || 0,
        videoTrackCount: stream?.getVideoTracks?.().length || 0
      })

      stopDisplayStream()
      displayStreamRef.current = stream
      syncLocalPreview()
      setPickerOpen(false)
      setShareState('sharing')

      const [videoTrack] = stream.getVideoTracks()
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          logShareDebug('displayTrack:ended', { trackId: videoTrack.id })
          void stopSharing()
        })
      }

      if (connectionState === 'connected') {
        try {
          await rebuildHostPeerConnections()
          announceShareState(true)
        } catch {
          setStatusMessage('本地共享已开始，网络协商失败，正在等待连接恢复后同步给其他参会人。')
          return
        }
      }
      setStatusMessage(
        connectionState === 'connected'
          ? '桌面共享中...'
          : '桌面共享已启动，正在等待会议连接恢复后同步给其他参会人。'
      )
      logShareDebug('beginShareWithSource:done', {
        isConnected: connectionState === 'connected'
      })
    } catch (error) {
      logShareDebug('beginShareWithSource:error', {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : ''
      })
      setShareState('idle')
      if (isLikelyPermissionError(error)) {
        setStatusMessage(
          `无法开始桌面共享：${error?.message || '权限不足。'} 请在系统设置里允许屏幕共享权限后重试。`
        )
      } else {
        setStatusMessage(`无法开始桌面共享：${error?.message || '未知错误。'}`)
      }
    }
  }, [
    announceShareState,
    connectionState,
    canManageShare,
    pickerSelectedSourceId,
    rebuildHostPeerConnections,
    stopDisplayStream,
    stopSharing,
    syncLocalPreview
  ])

  const closePicker = useCallback(() => {
    if (shareState !== 'starting') {
      setPickerOpen(false)
    }
  }, [shareState])

  useEffect(() => {
    if (!isMeetingWindow) {
      return undefined
    }

    if (initialSessionPayload && !initialSessionConsumedRef.current) {
      initialSessionConsumedRef.current = true
      setJoinRoomId(initialSessionPayload.roomId || '')
      setActiveRoomId(initialSessionPayload.roomId || '')
      setRoomInfo({
        roomId: initialSessionPayload.roomId || '',
        role: initialSessionPayload.role || 'host',
        ownerUserId: initialSessionPayload.ownerUserId || '',
        peerId: initialSessionPayload.peerId || '',
        hostPresent: initialSessionPayload.role === 'host',
        shareActive: false,
        participants: []
      })
      setConnectionState('connecting')
      void connectSocket(initialSessionPayload).catch((error) => {
        setRoomState('idle')
        setConnectionState('failed')
        setStatusMessage(error?.message || '进入会议失败。')
      })
    }

    return () => {
      resetShareSession({ preserveJoinRoomId: true })
    }
  }, [connectSocket, initialSessionPayload, isMeetingWindow, resetShareSession])

  useEffect(() => {
    if (!isMeetingWindow) {
      return undefined
    }

    const handleBeforeUnload = () => {
      const ownedRoomId = getOwnedRoomIdForCleanup()
      if (ownedRoomId) {
        removeMeetingRoom(ownedRoomId)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [getOwnedRoomIdForCleanup, isMeetingWindow])

  const closeMeeting = useCallback(async () => {
    await exitMeeting()
  }, [exitMeeting])

  return {
    roomState,
    shareState,
    connectionState,
    connectionLabel,
    canLeaveMeeting,
    currentPeerId,
    microphoneEnabled,
    microphoneState,
    statusMessage,
    activeRoomId,
    roomInfo,
    chatMessages,
    joinRoomId,
    setJoinRoomId,
    pickerOpen,
    pickerLoading,
    pickerSources,
    pickerSelectedSourceId,
    setPickerSelectedSourceId,
    localVideoRef,
    remoteVideoRef,
    localPreviewStream,
    remotePreviewStream,
    isJoined,
    isSharing,
    isHost,
    isRoomOwner,
    isViewer,
    createRoom,
    joinRoom,
    leaveRoom,
    closeMeeting,
    openSourcePicker,
    beginShareWithSource,
    closePicker,
    stopSharing,
    toggleMicrophone,
    sendChatText,
    sendChatImage
  }
}
