import { useCallback, useState } from 'react'
import { sleep } from '../utils/shareUtils'
import { useMeetingRtcSession } from './useMeetingRtcSession'

// 外层 controller 只处理会议页自己的 UI 状态，尤其是共享源选择器这类视图层状态。
// RTC / media / signaling 全都下沉到 useMeetingRtcSession，避免一个 hook 同时承担两层职责。
export function useScreenShareController(options) {
  const session = useMeetingRtcSession(options)
  const {
    isHost,
    isRoomOwner,
    canLeaveMeeting,
    shareState,
    setStatusMessage,
    beginShareWithSource: beginShareWithSourceImpl
  } = session
  const canManageShare = (isHost || isRoomOwner) && canLeaveMeeting
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerSources, setPickerSources] = useState([])
  const [pickerSelectedSourceId, setPickerSelectedSourceId] = useState('')

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
  }, [setStatusMessage])

  const openSourcePicker = useCallback(async () => {
    if (!canManageShare) {
      return
    }

    setPickerOpen(true)
    await loadShareSources()
  }, [canManageShare, loadShareSources])

  const closePicker = useCallback(() => {
    if (shareState !== 'starting') {
      setPickerOpen(false)
    }
  }, [shareState])

  const beginShareWithSource = useCallback(async () => {
    const started = await beginShareWithSourceImpl(pickerSelectedSourceId)
    if (started) {
      setPickerOpen(false)
    }
    return started
  }, [beginShareWithSourceImpl, pickerSelectedSourceId])

  return {
    ...session,
    pickerOpen,
    pickerLoading,
    pickerSources,
    pickerSelectedSourceId,
    setPickerSelectedSourceId,
    openSourcePicker,
    closePicker,
    beginShareWithSource
  }
}
