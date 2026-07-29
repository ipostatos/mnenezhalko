import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Impact as ImpactData } from '../types'
import { haptic } from '../telegram'

/**
 * «Сколько мы сберегли вместе» на главной (issue #13).
 *
 * Цифры — оценка, а не бухгалтерия, поэтому рядом стоит «примерно», а формула
 * раскрывается по нажатию: спорную методику честнее показать, чем прятать.
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

  return (
    <div className="impact card">
      <div className="impact-head">
        <span className="impact-emoji" aria-hidden="true">
          🌳
        </span>
        <div className="grow">
          <div className="t-sm" style={{ fontWeight: 700 }}>
            Вместе мы сберегли
          </div>
          <div className="d muted">
            {data.exchanges === 1 ? '1 обмен книгой' : `${data.exchanges} обменов книгами`}
          </div>
        </div>
      </div>

      <div className={`impact-nums${data.trees >= 0.1 ? '' : ' two'}`}>
        <div className="impact-num">
          <div className="n">≈{data.moneyPln}</div>
          <div className="c">злотых</div>
        </div>
        <div className="impact-num">
          <div className="n">≈{data.paperKg}</div>
          <div className="c">кг бумаги</div>
        </div>
        {/* деревья показываем, только когда их набралось на заметную долю:
            «примерно 0.01 дерева» — цифра честная, но выглядит как насмешка */}
        {data.trees >= 0.1 && (
          <div className="impact-num">
            <div className="n">≈{data.trees}</div>
            <div className="c">{treeWord(data.trees)}</div>
          </div>
        )}
      </div>

      <button
        className="link-btn"
        onClick={() => {
          haptic('light')
          setOpen((v) => !v)
        }}
      >
        {open ? 'Свернуть' : 'Как это посчитано'}
      </button>

      {open && (
        <p className="impact-note">
          Каждый обмен — это книга, которую не пришлось покупать новой. Считаем осторожно:{' '}
          {data.basis.pricePln} злотых за книгу (в магазинах обычно дороже),{' '}
          {data.basis.paperPerBookKg} кг бумаги в книге и {data.basis.paperPerTreeKg} кг бумаги из
          одного дерева. Это оценка, а не точный расчёт, поэтому все числа со словом «примерно».
        </p>
      )}
    </div>
  )
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
