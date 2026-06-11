import PropTypes from 'prop-types'
import {
  Copy,
  Download,
  Gauge,
  Image,
  MousePointer2,
  Music,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Trash2,
  Type,
  Undo2,
  Redo2,
  Video,
  Volume2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'

const ICON_SIZE = 16

const ICONS = {
  audio: Music,
  delete: Trash2,
  duplicate: Copy,
  export: Download,
  image: Image,
  importVideo: Video,
  pause: Pause,
  play: Play,
  redo: Redo2,
  reset: RotateCcw,
  select: MousePointer2,
  split: Scissors,
  speed: Gauge,
  text: Type,
  undo: Undo2,
  video: Video,
  volume: Volume2,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut
}

function renderIcon(Icon) {
  return <Icon aria-hidden="true" size={ICON_SIZE} strokeWidth={1} />
}

export function ImageIcon() {
  return renderIcon(Image)
}

export function VideoIcon() {
  return renderIcon(Video)
}

export function EditorIcon({ id }) {
  return renderIcon(ICONS[id] || Download)
}

EditorIcon.propTypes = {
  id: PropTypes.string.isRequired
}
