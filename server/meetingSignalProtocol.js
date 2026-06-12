const MEETING_SIGNAL_TYPES = {
  SUBSCRIBE_ROOMS: 'subscribe-rooms',
  ROOMS_SNAPSHOT: 'rooms-snapshot',
  HELLO: 'hello',
  WELCOME: 'welcome',
  ROOM_STATE: 'room-state',
  ROOM_CLOSED: 'room-closed',
  PEER_JOIN: 'peer-join',
  PEER_LEAVE: 'peer-leave',
  PARTICIPANT_JOINED: 'participant-joined',
  PARTICIPANT_LEFT: 'participant-left',
  PARTICIPANT_STATE_UPDATED: 'participant-state-updated',
  SHARE_STATE: 'share-state',
  SHARE_STARTED: 'share-started',
  SHARE_STOPPED: 'share-stopped',
  AUDIO_STATE: 'audio-state',
  GET_ROUTER_RTP_CAPABILITIES: 'get-router-rtp-capabilities',
  ROUTER_RTP_CAPABILITIES: 'router-rtp-capabilities',
  CREATE_SEND_TRANSPORT: 'create-send-transport',
  SEND_TRANSPORT_CREATED: 'send-transport-created',
  CONNECT_SEND_TRANSPORT: 'connect-send-transport',
  CREATE_RECV_TRANSPORT: 'create-recv-transport',
  RECV_TRANSPORT_CREATED: 'recv-transport-created',
  CONNECT_RECV_TRANSPORT: 'connect-recv-transport',
  PRODUCE: 'produce',
  PRODUCED: 'produced',
  NEW_PRODUCER: 'new-producer',
  CLOSE_PRODUCER: 'close-producer',
  PRODUCER_CLOSED: 'producer-closed',
  CONSUME: 'consume',
  CONSUMED: 'consumed',
  MEDIA_STATE: 'media-state',
  ACTIVE_SHARE_CHANGED: 'active-share-changed',
  CHAT_MESSAGE: 'chat-message',
  CHAT_MESSAGE_ACK: 'chat-message-ack',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  RENEGOTIATE_REQUEST: 'renegotiate-request',
  LEAVE: 'leave',
  ERROR: 'error'
}

function isMeetingSignalType(type) {
  return Object.values(MEETING_SIGNAL_TYPES).includes(type)
}

module.exports = {
  MEETING_SIGNAL_TYPES,
  isMeetingSignalType
}
