import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MessageContextMenuItem = {
  label: string
  onSelect: () => void
  destructive?: boolean
  icon?: ReactNode
}

interface MessageContextMenuProps {
  x: number
  y: number
  items: MessageContextMenuItem[]
  onClose: () => void
}

const MENU_MARGIN = 8

export function MessageContextMenu({ x, y, items, onClose }: MessageContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nextX = x
    let nextY = y
    if (nextX + rect.width + MENU_MARGIN > window.innerWidth) {
      nextX = Math.max(MENU_MARGIN, window.innerWidth - rect.width - MENU_MARGIN)
    }
    if (nextY + rect.height + MENU_MARGIN > window.innerHeight) {
      nextY = Math.max(MENU_MARGIN, window.innerHeight - rect.height - MENU_MARGIN)
    }
    setPosition({ x: nextX, y: nextY })
  }, [x, y])

  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
    first?.focus()
    return () => {
      previousFocusRef.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
        )
        if (buttons.length === 0) return
        e.preventDefault()
        const current = document.activeElement as HTMLElement | null
        const idx = current ? buttons.indexOf(current as HTMLButtonElement) : -1
        let next = 0
        if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % buttons.length
        else if (e.key === 'ArrowUp') next = idx <= 0 ? buttons.length - 1 : idx - 1
        else if (e.key === 'End') next = buttons.length - 1
        buttons[next].focus()
      }
    }
    const onScroll = () => onClose()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ top: position.y, left: position.x }}
      className="fixed z-50 min-w-[180px] rounded-md border border-border bg-card text-foreground vc-panel-shadow py-1"
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
          className={
            'w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:bg-accent focus-visible:text-accent-foreground ' +
            (item.destructive
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-foreground hover:bg-accent hover:text-accent-foreground')
          }
        >
          {item.icon && <span className="shrink-0">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}
