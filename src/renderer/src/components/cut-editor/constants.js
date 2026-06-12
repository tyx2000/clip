export const MIN_CLIP_DURATION = 0.2
export const HISTORY_LIMIT = 80
export const TIMELINE_ZOOM_DEFAULT = 10
export const TIMELINE_ZOOM_MIN = 4
export const TIMELINE_ZOOM_MAX = 80
export const TRACK_GUTTER_WIDTH = 16
export const CLIP_SNAP_DISTANCE_PX = 8
export const TIMELINE_AUTO_SCROLL_EDGE_PX = 36
export const TIMELINE_AUTO_SCROLL_STEP_PX = 18
export const OVERLAY_FADE_SECONDS = 0.35
export const DEFAULT_TRANSITION = 'rotateY'
export const DEFAULT_VIDEO_TRANSITION_SECONDS = 0.35
export const CENTER_SNAP_THRESHOLD = 1.5

export const DEFAULT_EXPORT = {
  bitrate: 4_000_000,
  fps: 30,
  height: 0,
  width: 0
}

export const TEXT_DEFAULTS = {
  align: 'center',
  backgroundAlpha: 0.58,
  backgroundColor: '#000000',
  color: '#ffffff',
  fontFamily: 'Avenir Next, Helvetica, sans-serif',
  fontSize: 22,
  fontWeight: '800',
  lineHeight: 1.2,
  shadowBlur: 8,
  shadowColor: '#000000',
  shadowDistance: 2,
  strokeColor: '#000000',
  strokeWidth: 0
}

export const BASE_TRACKS = [
  { id: 'video', label: '视频', kind: 'video' },
  { id: 'audio', label: '音频', kind: 'audio' },
  { id: 'image', label: '叠图', kind: 'image' },
  { id: 'text', label: '字幕', kind: 'text' }
]

export const MEDIA_TOOLS = [
  { id: 'text', label: '文本', kind: 'text' },
  { id: 'image', label: '贴图', kind: 'image' },
  { id: 'audio', label: '音频', kind: 'audio' },
  { id: 'importVideo', label: '导入视频', kind: 'video' }
]

export const TIMELINE_EDIT_ACTIONS = [
  { id: 'undo', label: '后退' },
  { id: 'redo', label: '前进' },
  { id: 'duplicate', label: '复制' },
  { id: 'split', label: '剪切' },
  { id: 'delete', label: '删除' }
]

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

export const TRANSITION_OPTIONS = ['none', 'fade', 'rotateY']

export const VIDEO_TRANSITION_OPTIONS = [
  { label: '无', value: 'none' },
  { label: '淡入淡出', value: 'fade' },
  { label: '左滑', value: 'slideLeft' },
  { label: '右滑', value: 'slideRight' },
  { label: '上滑', value: 'slideUp' },
  { label: '下滑', value: 'slideDown' }
]

export const TEXT_WEIGHT_OPTIONS = ['400', '500', '700', '800', '900']

export const TEXT_FONT_OPTIONS = [
  { label: 'Avenir Next', value: 'Avenir Next, Helvetica, sans-serif' },
  { label: 'PingFang SC', value: 'PingFang SC, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Mono', value: 'SFMono-Regular, Consolas, monospace' }
]

export const TEXT_ALIGN_OPTIONS = ['left', 'center', 'right']
