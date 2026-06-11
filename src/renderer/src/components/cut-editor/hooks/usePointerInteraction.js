import { useEffect, useEffectEvent } from 'react'

export function usePointerInteraction({ onPointerCancel, onPointerMove, onPointerUp }) {
  const handlePointerCancel = useEffectEvent((event) => {
    onPointerCancel?.(event)
  })
  const handlePointerMove = useEffectEvent((event) => {
    onPointerMove?.(event)
  })
  const handlePointerUp = useEffectEvent((event) => {
    onPointerUp?.(event)
  })

  useEffect(() => {
    const handleMove = (event) => {
      handlePointerMove(event)
    }
    const handleUp = (event) => {
      handlePointerUp(event)
    }
    const handleCancel = (event) => {
      handlePointerCancel(event)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleCancel)

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleCancel)
    }
  }, [])
}
