import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isLikelyPermissionError, sleep } from '../utils/shareUtils'
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]
const MAX_RECONNECT_ATTEMPTS = 6

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

function isFatalSocketError(message) {
  return message === 'Room not found.' || message === 'Invalid room token.'
}

function getReconnectDelay(attempt) {
  return Math.min(1000 * attempt, 4000)
}

function hasEnabledTrack(stream) {
  return Boolean(stream?.getTracks().some((track) => track.enabled))
}

export function useScreenShareController({
  isMeetingWindow,
  initialRoomId = '',
  initialSessionPayload = null
}) {
  const [roomState, setRoomState] = useState('idle')
  const [shareState, setShareState] = useState('idle')
  const [connectionState, setConnectionState] = useState('idle')
  const [statusMessage, setStatusMessage] = useState('准备创建会议房间。')
  const [roomInfo, setRoomInfo] = useState(null)
  const [joinRoomId, setJoinRoomId] = useState(initialRoomId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerSources, setPickerSources] = useState([])
  const [pickerSelectedSourceId, setPickerSelectedSourceId] = useState('')
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [microphoneState, setMicrophoneState] = useState('idle')

  const wsRef = useRef(null)
  const displayStreamRef = useRef(null)
  const microphoneStreamRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const hostPeerConnectionsRef = useRef(new Map())
  const viewerPeerConnectionRef = useRef(null)
  const hostRemoteAudioRef = useRef(new Map())
  const viewerPeerIdsRef = useRef(new Set())
  const sessionRef = useRef(createEmptySession())
  const intentionalCloseRef = useRef(false)
  const reconnectTimerRef = useRef(null)
  const reconnectAttemptsRef = useRef(0)
  const microphoneRequestInFlightRef = useRef(null)
  const buildHostPeerConnectionRef = useRef(async () => null)
  const initialSessionConsumedRef = useRef(false)

  const isJoined = roomState === 'joined' && Boolean(roomInfo?.roomId)
  const isSharing = shareState === 'sharing'
  const isHost = roomInfo?.role === 'host'
  const isViewer = roomInfo?.role === 'viewer'

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
    applyStreamToVideo(localVideoRef.current, displayStreamRef.current)
  }, [applyStreamToVideo])

  const syncRemotePreview = useCallback(
    (stream = null) => {
      applyStreamToVideo(remoteVideoRef.current, stream)
    },
    [applyStreamToVideo]
  )

  const sendSocketMessage = useCallback((payload) => {
    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false
    }
    socket.send(JSON.stringify(payload))
    return true
  }, [])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

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
      cleanupRemoteAudio(peerId)
    }
    hostPeerConnectionsRef.current.clear()
  }, [cleanupRemoteAudio])

  const closeViewerPeerConnection = useCallback(() => {
    if (viewerPeerConnectionRef.current) {
      viewerPeerConnectionRef.current.close()
      viewerPeerConnectionRef.current = null
    }
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

  const updateRoomInfo = useCallback(
    (room, options = {}) => {
      const role = options.role || sessionRef.current.role || room?.role || roomInfo?.role || 'host'

      setRoomInfo((previous) => ({
        ...(previous || {}),
        ...(room || {}),
        role
      }))
    },
    [roomInfo?.role]
  )

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
      reconnectAttemptsRef.current = 0
      if (wsRef.current) {
        const socket = wsRef.current
        wsRef.current = null
        socket.close()
      }
      sessionRef.current = createEmptySession()
      setRoomInfo(null)
      setRoomState('idle')
      setShareState('idle')
      setConnectionState('idle')
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

  const buildHostPeerConnection = useCallback(
    async (viewerPeerId) => {
      if (!viewerPeerId || !wsRef.current) {
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
    [addLocalAudioTracks, cleanupRemoteAudio, sendSocketMessage]
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

    peerConnection.onconnectionstatechange = () => {
      if (
        peerConnection.connectionState === 'failed' ||
        peerConnection.connectionState === 'closed' ||
        peerConnection.connectionState === 'disconnected'
      ) {
        syncRemotePreview(null)
      }
    }

    addLocalAudioTracks(peerConnection)
    return peerConnection
  }, [addLocalAudioTracks, sendSocketMessage, syncRemotePreview])

  const ensureMicrophoneStream = useCallback(async ({ silent = false } = {}) => {
    if (microphoneStreamRef.current) {
      const tracks = microphoneStreamRef.current.getAudioTracks()
      tracks.forEach((track) => {
        track.enabled = true
      })
      setMicrophoneEnabled(true)
      setMicrophoneState('active')
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
  }, [])

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
    setStatusMessage(nextEnabled ? '麦克风已开启。' : '麦克风已关闭。')
  }, [
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
      roomInfo?.shareActive,
      sendSocketMessage,
      updateRoomInfo
    ]
  )

  const connectSocket = useCallback(
    ({ roomId, role, peerId, token, wsUrl }, options = {}) => {
      const reconnect = Boolean(options.reconnect)

      return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl)
        let settled = false
        let reconnectableClose = true
        let closeReason = ''

        setConnectionState(reconnect ? 'reconnecting' : 'connecting')

        socket.onopen = () => {
          intentionalCloseRef.current = false
          socket.send(
            JSON.stringify({
              type: 'hello',
              roomId,
              role,
              peerId,
              token
            })
          )
        }

        socket.onmessage = async (event) => {
          const message = JSON.parse(event.data)
          if (message.type === 'error') {
            closeReason = message.message || '房间连接失败。'
            reconnectableClose = !isFatalSocketError(message.message)
            if (!settled) {
              settled = true
              reject(new Error(closeReason))
            }
            setConnectionState('failed')
            setStatusMessage(closeReason)
            socket.close()
            return
          }

          if (message.type === 'welcome') {
            wsRef.current = socket
            sessionRef.current = { roomId, role, peerId, token, wsUrl }
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
                    ? '会议已重新连接，正在恢复语音和桌面共享。'
                    : '会议已重新连接，语音通话已恢复。'
                  : '会议房间已创建。把房间号发给另一端 Electron 应用即可加入。'
              )
            } else {
              setStatusMessage(
                reconnect
                  ? message.room?.shareActive
                    ? '已重新加入会议，正在恢复共享画面。'
                    : '已重新加入会议，当前只有语音通话。'
                  : message.room?.shareActive
                    ? '已加入会议，正在接入共享画面。'
                    : '已加入会议，当前只有语音通话。'
              )
            }

            if (!settled) {
              settled = true
              resolve(message)
            }

            if (role === 'host' && (microphoneStreamRef.current || displayStreamRef.current)) {
              Promise.resolve().then(async () => {
                for (const viewerPeerId of viewerPeerIdsRef.current) {
                  await buildHostPeerConnectionRef.current(viewerPeerId)
                }
                if (displayStreamRef.current) {
                  announceShareState(true)
                  setShareState('sharing')
                }
              })
            }
          }

          await handleSocketMessage(message)
        }

        socket.onclose = () => {
          if (wsRef.current === socket) {
            wsRef.current = null
          }

          closeHostPeerConnections()
          closeViewerPeerConnection()

          if (!settled) {
            settled = true
            reject(new Error(closeReason || 'Room socket closed before ready.'))
          }

          if (intentionalCloseRef.current) {
            return
          }

          if (role === 'viewer') {
            setShareState('idle')
          }

          if (!reconnectableClose) {
            if (role === 'host') {
              stopDisplayStream()
              setShareState('idle')
            }
            setConnectionState('failed')
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
            void connectSocket({ roomId, role, peerId, token, wsUrl }, { reconnect: true }).catch(
              () => {}
            )
          }, getReconnectDelay(nextAttempt))
        }

        socket.onerror = () => {
          if (!settled && !reconnect) {
            settled = true
            reject(new Error('Failed to connect room socket.'))
          }
        }
      })
    },
    [
      announceShareState,
      clearReconnectTimer,
      closeHostPeerConnections,
      closeViewerPeerConnection,
      handleSocketMessage,
      stopDisplayStream,
      updateRoomInfo
    ]
  )

  const createRoom = useCallback(async () => {
    clearReconnectTimer()
    setRoomState('creating')
    setConnectionState('connecting')
    setStatusMessage('正在创建会议房间...')

    try {
      if (typeof window.api?.createScreenShareRoom !== 'function') {
        throw new Error('共享服务不可用。')
      }

      const payload = await window.api.createScreenShareRoom()
      if (!payload?.ok) {
        throw new Error(payload?.message || '创建会议房间失败。')
      }

      await connectSocket(payload)
      return payload
    } catch (error) {
      setRoomState('idle')
      setConnectionState('failed')
      setStatusMessage(error?.message || '创建会议房间失败。')
      return null
    }
  }, [clearReconnectTimer, connectSocket])

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

      const payload = await window.api.joinScreenShareRoom({ roomId: normalizedRoomId })
      if (!payload?.ok) {
        throw new Error(payload?.message || '加入会议房间失败。')
      }

      await connectSocket(payload)
      return payload
    } catch (error) {
      setRoomState('idle')
      setConnectionState('failed')
      setStatusMessage(error?.message || '加入会议房间失败。')
      return null
    }
  }, [clearReconnectTimer, connectSocket, joinRoomId])

  const leaveRoom = useCallback(() => {
    sendSocketMessage({ type: 'leave' })
    resetShareSession({ preserveJoinRoomId: true })
    setStatusMessage('已离开会议房间。')
  }, [resetShareSession, sendSocketMessage])

  const loadShareSources = useCallback(async () => {
    setPickerLoading(true)
    setPickerSources([])
    const minimumLoading = sleep(1500)

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
    } catch (error) {
      await minimumLoading
      setStatusMessage(error?.message || '读取共享源失败。')
    } finally {
      setPickerLoading(false)
    }
  }, [])

  const openSourcePicker = useCallback(async () => {
    if (!isJoined || !isHost) {
      return
    }
    if (connectionState !== 'connected') {
      setStatusMessage('会议正在重连，请等待连接恢复后再开始桌面共享。')
      return
    }
    setPickerOpen(true)
    await loadShareSources()
  }, [connectionState, isHost, isJoined, loadShareSources])

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
    if (!pickerSelectedSourceId || !isHost || !isJoined) {
      return
    }

    if (connectionState !== 'connected') {
      setStatusMessage('会议正在重连，请等待连接恢复后再开始桌面共享。')
      return
    }

    setPickerOpen(false)
    setShareState('starting')
    setStatusMessage('正在请求桌面共享权限...')

    try {
      const setter = window.api?.setScreenShareSource
      if (typeof setter === 'function') {
        const result = await setter({ sourceId: pickerSelectedSourceId })
        if (!result?.ok) {
          throw new Error(result?.message || '设置共享源失败。')
        }
      }

      const stream = await window.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      })

      stopDisplayStream()
      displayStreamRef.current = stream
      syncLocalPreview()

      const [videoTrack] = stream.getVideoTracks()
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          void stopSharing()
        })
      }

      await rebuildHostPeerConnections()
      announceShareState(true)
      setShareState('sharing')
      setStatusMessage('桌面共享中...')
    } catch (error) {
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
    isHost,
    isJoined,
    pickerSelectedSourceId,
    rebuildHostPeerConnections,
    stopDisplayStream,
    stopSharing,
    syncLocalPreview
  ])

  const copyRoomId = useCallback(async () => {
    if (!roomInfo?.roomId) {
      return
    }

    try {
      await window.navigator.clipboard.writeText(roomInfo.roomId)
      setStatusMessage('房间号已复制，请在另一端 Electron 应用中打开会议窗口并加入。')
    } catch {
      setStatusMessage(`房间号：${roomInfo.roomId}`)
    }
  }, [roomInfo?.roomId])

  const closePicker = useCallback(() => {
    if (shareState !== 'starting') {
      setPickerOpen(false)
    }
  }, [shareState])

  const noopToggle = useCallback(() => {}, [])

  useEffect(() => {
    if (!isMeetingWindow) {
      return undefined
    }

    void ensureMicrophoneStream({ silent: true }).catch(() => {})

    if (initialSessionPayload && !initialSessionConsumedRef.current) {
      initialSessionConsumedRef.current = true
      setJoinRoomId(initialSessionPayload.roomId || '')
      void connectSocket(initialSessionPayload).catch((error) => {
        setRoomState('idle')
        setConnectionState('failed')
        setStatusMessage(error?.message || '进入会议失败。')
      })
    }

    return () => {
      resetShareSession({ preserveJoinRoomId: true })
    }
  }, [
    connectSocket,
    ensureMicrophoneStream,
    initialSessionPayload,
    isMeetingWindow,
    resetShareSession
  ])

  return {
    roomState,
    shareState,
    connectionState,
    connectionLabel,
    microphoneEnabled,
    microphoneState,
    statusMessage,
    roomInfo,
    joinRoomId,
    setJoinRoomId,
    pickerOpen,
    pickerLoading,
    pickerSources,
    pickerSelectedSourceId,
    setPickerSelectedSourceId,
    localVideoRef,
    remoteVideoRef,
    isJoined,
    isSharing,
    isHost,
    isViewer,
    createRoom,
    joinRoom,
    leaveRoom,
    openSourcePicker,
    beginShareWithSource,
    closePicker,
    copyRoomId,
    stopSharing,
    toggleMicrophone,
    noopToggle
  }
}
