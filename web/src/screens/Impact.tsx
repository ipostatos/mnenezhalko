import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Impact as ImpactData } from '../types'
import { haptic } from '../telegram'
import { Icon } from './Icon'

/**
 * «Польза сообщества» на главной (issue #13) — карточка результата, а не
 * раскрывающийся абзац текста (ревью дизайна 29.07.2026).
 *
 * Что решает вёрстка:
 *
 * 1. **Один главный показатель.** В свёрнутом виде спорят за внимание только
 *    надзаголовок, крупная сумма и строка «сберегли вместе · N обменов».
 *    Всё остальное — под раскрытием.
 * 2. **Две метрики, а не три равных.** Деньги и экология читаются разным
 *    цветом (персиковая и зелёная плашки), деревья ушли третьей строкой
 *    внутрь зелёной: это уточнение к бумаге, а не отдельный итог.
 * 3. **Методика — списком.** Сплошной абзац на телефоне не сканируется,
 *    поэтому коэффициенты стоят буллетами, а оговорка — отдельной строкой.
 *
 * Цифры — оценка, а не бухгалтерия, поэтому рядом стоит «примерно», а формула
 * показывается тут же: спорную методику честнее показать, чем прятать.
 * Блок молчит, пока обменов нет: «сберегли 0 злотых» — плохое приветствие.
 */
export function Impact() {
  const [data, setData] = useState<ImpactData | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .impact()
      .then((r) => alive && setData(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (!data || !data.exchanges) return null

  const money = `≈${group(data.moneyPln)} zł`

  return (
    <div className="impact card">
      <button
        className="impact-head"
        aria-expanded={open}
        onClick={() => {
          haptic('light')
          setOpen((v) => !v)
        }}
      >
        <span className="impact-ic" aria-hidden="true">
          <Icon name="sprout" />
        </span>
        <span className="grow">
          <span className="impact-eyebrow">Польза сообщества</span>
          <span className="impact-hero">{money}</span>
          {/* коротко: со словом «книгами» строка переносилась на узких экранах */}
          <span className="impact-sub">
            сберегли вместе · {data.exchanges} {exchangeWord(data.exchanges)}
          </span>
        </span>
        <span className={`chev${open ? ' up' : ''}`} aria-hidden="true">
          ›
        </span>
      </button>

      {open && (
        <>
          <div className="impact-nums">
            <div className="impact-num money">
              <div className="n">{money}</div>
              <div className="c">сберегли вместе</div>
            </div>
            <div className="impact-num eco">
              <div className="n">≈{data.paperKg} кг</div>
              <div className="c">бумаги сохранили</div>
              {/* деревья показываем, только когда их набралось на заметную долю:
                  «примерно 0.01 дерева» — цифра честная, но выглядит как насмешка */}
              {data.trees >= 0.1 && (
                <div className="x">
                  это ≈{data.trees} {treeWord(data.trees)}
                </div>
              )}
            </div>
          </div>

          <div className="impact-how">
            <div className="impact-how-t">Как считаем</div>
            <ul>
              <li>~{data.basis.pricePln} zł за книгу</li>
              <li>~{data.basis.paperPerBookKg} кг бумаги на книгу</li>
              <li>~{data.basis.paperPerTreeKg} кг бумаги из одного дерева</li>
            </ul>
            <p className="impact-note">
              Каждый обмен — книга, которую не пришлось покупать новой. Это приблизительная оценка, а
              не точный расчёт: в магазинах книги обычно дороже.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Разряды в сумме: «8000 zł» на телефоне читается как набор цифр, «8 000 zł» —
 * как деньги. Пробел неразрывный, чтобы сумма не переносилась посередине.
 * Считаем руками, а не через Intl: результат одинаков в браузере и в тестах.
 */
export const NBSP = ' '

export function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** «1 обмен», «2 обмена», «5 обменов». */
export function exchangeWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'обмен'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'обмена'
  return 'обменов'
}

/** «1 дерево», «2 дерева», «5 деревьев» — и дробные, которых тут большинство. */
export function treeWord(n: number): string {
  if (!Number.isInteger(n)) return 'дерева'
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'дерево'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дерева'
  return 'деревьев'
}
