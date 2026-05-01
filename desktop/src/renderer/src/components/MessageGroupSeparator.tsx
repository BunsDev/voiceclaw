interface MessageGroupSeparatorProps {
  label: string
}

export function MessageGroupSeparator({ label }: MessageGroupSeparatorProps) {
  return (
    <div className="flex items-center justify-center my-4 select-none">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
    </div>
  )
}
