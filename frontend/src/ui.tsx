import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, ChevronsUpDown, Search, X } from "lucide-react"

export type SelectOption<T extends string = string> = {
  value: T
  label: string
  sub?: string
  tag?: string
  tagKind?: "ok" | "off"
  dot?: boolean
  disabled?: boolean
  group?: string
}

type SelectProps<T extends string> = {
  value?: T
  selected?: T[]
  options: SelectOption<T>[]
  onChange?: (value: T) => void
  onToggle?: (value: T, checked: boolean) => void
  placeholder?: string
  searchable?: boolean
  multiple?: boolean
  footer?: ReactNode
  className?: string
  ariaLabel?: string
}

export function Select<T extends string>({
  value,
  selected,
  options,
  onChange,
  onToggle,
  placeholder = "请选择",
  searchable = true,
  multiple = false,
  footer,
  className = "",
  ariaLabel,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const multi = multiple || !!onToggle
  const picked = multi ? (selected ?? []) : value

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  const needle = query.trim().toLowerCase()
  const visible = options.filter(
    (option) =>
      !needle ||
      `${option.value} ${option.label} ${option.sub ?? ""}`.toLowerCase().includes(needle),
  )
  const current = options.find((option) => option.value === value)
  const groups: Array<{ name: string; options: SelectOption<T>[] }> = []
  for (const option of visible) {
    const key = option.group ?? ""
    const group = groups[groups.length - 1]
    if (!group || group.name !== key) groups.push({ name: key, options: [option] })
    else group.options.push(option)
  }

  const toggle = (option: SelectOption<T>) => {
    if (multi) {
      const checked = !(picked as T[]).includes(option.value)
      onToggle?.(option.value, checked)
    } else {
      onChange?.(option.value)
      setOpen(false)
      setQuery("")
    }
  }

  return (
    <div className={`select ${className}`} ref={rootRef}>
      <button
        type="button"
        className={`select-trigger${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          setOpen((value) => !value)
          setQuery("")
        }}
      >
        <span className={`select-dot${current?.dot ? " on" : ""}`} />
        <span className="select-main">
          <span className="select-label" title={current?.label}>{current?.label ?? placeholder}</span>
          {current?.sub ? <span className="select-sub">{current.sub}</span> : null}
        </span>
        <span className="select-caret">{open ? <ChevronDown size={15} /> : <ChevronsUpDown size={15} />}</span>
      </button>
      {open ? (
        <div className="select-popover" role="listbox">
          {searchable ? (
            <div className="select-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                placeholder="搜索…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}
          <div className="select-list">
            {groups.length === 0 ? <div className="select-empty">没有匹配的选项</div> : null}
            {groups.map((group) => (
              <div key={group.name || "__root"}>
                {group.name ? <div className="select-group">{group.name}</div> : null}
                {group.options.map((option) => {
                  const isSelected = multi
                    ? (picked as T[]).includes(option.value)
                    : option.value === value
                  return (
                    <button
                      type="button"
                      key={option.value}
                      className={`select-option${isSelected ? " selected" : ""}`}
                      role="option"
                      aria-selected={isSelected}
                      disabled={option.disabled}
                      onClick={() => toggle(option)}
                    >
                      <span className="select-check" aria-hidden="true">
                        {isSelected ? <Check size={11} color="#fff" /> : null}
                      </span>
                      <span className={`select-dot${option.dot ? " on" : ""}`} aria-hidden="true" />
                      <span className="select-opt-id" title={option.label}>{option.label}</span>
                      <span className="select-opt-name">{option.sub ?? ""}</span>
                      {option.tag ? (
                        <span className={`select-opt-tag ${option.tagKind ?? "ok"}`}>{option.tag}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          {footer ? <div className="select-foot">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

type ModalProps = {
  title: string
  subtitle?: string
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  nav?: ReactNode
  wide?: boolean
  className?: string
}

export function Modal({ title, subtitle, icon, onClose, children, footer, nav, wide, className = "" }: ModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target as HTMLElement).closest?.(".select")) onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <div className="modal-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className={`modal${wide ? " wide" : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          {icon ? <span className="integ-icon">{icon}</span> : null}
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className={`modal-body${nav ? " split" : ""}`}>
          {nav}
          <div className="modal-main">{children}</div>
        </div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

type SegmentedOption = {
  value: string
  label: string
  desc?: string
}

export function Segmented({
  name,
  options,
  value,
  onChange,
  layout = "three",
}: {
  name: string
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  layout?: "three" | "two" | "rows"
}) {
  return (
    <fieldset className={`segmented ${layout}`}>
      {options.map((option) => (
        <label className="seg-option" key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="seg-body">
            <b>{option.label}</b>
            {option.desc ? <small>{option.desc}</small> : null}
          </span>
        </label>
      ))}
    </fieldset>
  )
}

export function Toggle({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  title: string
  desc?: string
}) {
  return (
    <label className="switch-row">
      <input
        className="switch-input"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      <span className="switch-body">
        <b>{title}</b>
        {desc ? <small>{desc}</small> : null}
      </span>
    </label>
  )
}

export type ToastItem = {
  id: number
  message: string
  kind?: "error" | "success"
}

export function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="toast-stack" role="status">
      {toasts.map((toast) => (
        <div className={`toast${toast.kind ? ` ${toast.kind}` : ""}`} key={toast.id}>
          {toast.message}
        </div>
      ))}
    </div>
  )
}
