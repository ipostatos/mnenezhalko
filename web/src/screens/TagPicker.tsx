import { useMemo, useState } from 'react'
import { haptic } from '../telegram'

/** Сколько вариантов показываем сразу: остальные — по кнопке или через поиск. */
const VISIBLE = 16
/** С какого размера справочника нужен поиск (жанров больше сотни). */
const SEARCH_FROM = 20

/** Сравнение «по-человечески»: регистр, ё/е и лишние пробелы не мешают найти. */
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim()

/**
 * Выбор значений из справочника проекта — жанры и языки.
 *
 * Свободного ввода здесь нет намеренно: раньше жанр и язык писались руками через
 * запятую, и в общей таблице копились синонимы, опечатки и просто мусор, а
 * админам приходилось это разбирать. Список приходит с сервера из Notion
 * (см. server/src/taxonomy.ts); новые значения заводятся только там.
 *
 * Уже стоящие у книги значения показываем, даже если их нет в справочнике
 * (старые книги), — снять такое можно, а вернуть уже нельзя.
 */
export function TagPicker({
  options,
  value,
  onChange,
  max,
  searchPlaceholder = 'Найти в списке…',
  emptyHint,
}: {
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  max?: number
  searchPlaceholder?: string
  emptyHint?: string
}) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)

  // значения книги, которых в справочнике уже нет: показываем их первыми, чтобы
  // человек видел, что у книги стоит, и мог это снять
  const legacy = useMemo(
    () => value.filter((v) => !options.some((o) => norm(o) === norm(v))),
    [options, value],
  )
  const allOptions = useMemo(() => [...legacy, ...options], [legacy, options])

  const needle = norm(q)
  const matched = needle ? allOptions.filter((o) => norm(o).includes(needle)) : allOptions
  // выбранное видно всегда, даже если обрезка списка его прячет; порядок при
  // этом не скачет — выбранная плашка остаётся там, где на неё нажали
  const shown = all || needle ? matched : matched.slice(0, VISIBLE)
  const list = [...shown, ...value.filter((v) => matched.includes(v) && !shown.includes(v))]
  const hidden = matched.length - shown.length

  const atMax = max !== undefined && value.length >= max

  function toggle(option: string) {
    haptic('light')
    if (value.includes(option)) {
      onChange(value.filter((v) => v !== option))
      return
    }
    if (atMax) return
    onChange([...value, option])
  }

  return (
    <>
      {allOptions.length >= SEARCH_FROM && (
        <input
          className="input sm"
          placeholder={searchPlaceholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ marginBottom: 'var(--sp-2)' }}
        />
      )}

      <div className="chips">
        {list.map((o) => {
          const on = value.includes(o)
          return (
            <button
              key={o}
              type="button"
              className={`chip sm ${on ? 'active' : ''}${!on && atMax ? ' off' : ''}`}
              aria-pressed={on}
              onClick={() => toggle(o)}
            >
              {o}
            </button>
          )
        })}
        {hidden > 0 && !needle && (
          <button type="button" className="chip sm ghost" onClick={() => setAll(true)}>
            ещё {hidden} →
          </button>
        )}
      </div>

      {needle && matched.length === 0 && (
        <div className="muted" style={{ marginTop: 'var(--sp-2)' }}>
          Такого нет в списке проекта. Новые значения заводят администраторы —
          напишите в чат, если чего-то не хватает.
        </div>
      )}
      {atMax && (
        <div className="muted" style={{ marginTop: 'var(--sp-2)' }}>
          Больше {max} не нужно — снимите лишнее, чтобы выбрать другое.
        </div>
      )}
      {!value.length && emptyHint && (
        <div className="muted" style={{ marginTop: 'var(--sp-2)' }}>
          {emptyHint}
        </div>
      )}
    </>
  )
}
