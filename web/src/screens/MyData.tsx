import { useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import { haptic, showAlert, showConfirm } from '../telegram'
import { CONTROLLER, PRIVACY, isPlaceholder, type PrivacyLang } from '../privacy-text'
import { Icon } from './Icon'

/**
 * «Ваши данные»: что о человеке хранится, зачем, на сколько, и две рабочие
 * кнопки — забрать всё файлом и удалить себя из проекта.
 *
 * Экран сделан так, чтобы правами можно было воспользоваться СРАЗУ, а не писать
 * письмо и ждать ответа: обещание в тексте без работающей кнопки ничего не
 * стоит. Перед удалением показываем, что именно исчезнет, числами.
 */
export function MyData({ go }: { go: (r: Route) => void }) {
  const [lang, setLang] = useState<PrivacyLang>('ru')
  const t = PRIVACY[lang]

  const [busy, setBusy] = useState<'export' | 'preview' | 'delete' | null>(null)
  const [preview, setPreview] = useState<{ summary: Record<string, number>; effects: string[] } | null>(null)
  const [blocked, setBlocked] = useState<{ title: string; role: string }[] | null>(null)
  const [done, setDone] = useState(false)

  async function download() {
    haptic()
    setBusy('export')
    try {
      const data = await api.exportMyData()
      const text = JSON.stringify(data, null, 2)
      // вебвью Telegram по-разному относится к скачиванию: пробуем файл, а если
      // не вышло — кладём в буфер обмена, чтобы человек всё равно унёс свои данные
      try {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `mnenezhalko-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        showAlert('Файл с вашими данными сохранён.')
      } catch {
        await navigator.clipboard.writeText(text)
        showAlert('Скачать файл не получилось, поэтому данные скопированы в буфер обмена.')
      }
    } catch (e: any) {
      showAlert(
        e?.message === 'too_many'
          ? 'Слишком часто. Попробуйте через час.'
          : 'Не получилось собрать выгрузку. Попробуйте позже.',
      )
    } finally {
      setBusy(null)
    }
  }

  async function askDelete() {
    haptic()
    setBusy('preview')
    setBlocked(null)
    try {
      const r = await api.deletePreview()
      setPreview({ summary: r.summary, effects: r.effects ?? [] })
    } catch (e: any) {
      if (e?.message === 'active_loans') {
        // 409 приходит с телом, но req() отдаёт только код ошибки — показываем
        // человеку понятную причину, подробности он видит на экране выдач
        setBlocked([])
      } else {
        showAlert('Не получилось посчитать. Попробуйте позже.')
      }
    } finally {
      setBusy(null)
    }
  }

  async function reallyDelete() {
    if (!(await showConfirm('Удалить все свои данные? Это необратимо.'))) return
    setBusy('delete')
    try {
      await api.deleteMyData()
      haptic('success')
      setDone(true)
    } catch (e: any) {
      if (e?.message === 'active_loans') setBlocked([])
      else showAlert('Не получилось удалить. Напишите нам, пожалуйста.')
    } finally {
      setBusy(null)
    }
  }

  if (done) {
    return (
      <div className="empty">
        <div className="big">🕊</div>
        <h1>Данные удалены</h1>
        <div className="sub">
          Профиль, отзывы и очереди убраны, книги сняты с полки. Записи о прошлых обменах
          остались в истории проекта, но узнать в них вас уже нельзя.
        </div>
        <div style={{ height: 'var(--sp-4)' }} />
        <div className="foot">
          Если снова захотите пользоваться проектом, просто откройте бота заново — это будет
          новый профиль.
        </div>
      </div>
    )
  }

  return (
    <>
      <h1>{t.title}</h1>
      <div className="sub">{t.updated}</div>

      <div className="chips" style={{ marginBottom: 'var(--sp-4)' }}>
        <button className={`chip sm ${lang === 'ru' ? 'active' : ''}`} onClick={() => setLang('ru')}>
          По-русски
        </button>
        <button className={`chip sm ${lang === 'pl' ? 'active' : ''}`} onClick={() => setLang('pl')}>
          Po polsku
        </button>
      </div>

      <div className="note">{t.intro}</div>

      <div className="section-title">{t.controllerTitle}</div>
      <div className="card">
        <div className="d muted" style={{ marginBottom: 'var(--sp-2)' }}>
          {t.controllerNote}
        </div>
        {/* пока реквизиты не подставлены, показываем ОДНУ честную строку, а не
            три одинаковые: это заметный пробел, а не оформление */}
        {[CONTROLLER.name, CONTROLLER.address, CONTROLLER.email].every(isPlaceholder) ? (
          <div className="d" style={{ color: 'var(--warn)' }}>
            {t.placeholderNote}
          </div>
        ) : (
          <>
            <Field value={CONTROLLER.name} note={t.placeholderNote} />
            <Field value={CONTROLLER.address} note={t.placeholderNote} />
            <Field value={CONTROLLER.email} note={t.placeholderNote} />
          </>
        )}
      </div>

      {t.sections.map((s) => (
        <div key={s.title}>
          <div className="section-title">{s.title}</div>
          <ul className="data-list">
            {s.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ))}

      <div className="section-title">{t.retentionTitle}</div>
      <div className="d muted" style={{ marginBottom: 'var(--sp-3)' }}>
        {t.retentionNote}
      </div>
      <div className="retention">
        {t.retention.map(([what, how]) => (
          <div className="retention-row" key={what}>
            <span className="w">{what}</span>
            <span className="h">{how}</span>
          </div>
        ))}
      </div>

      <div className="section-title">{t.rightsTitle}</div>
      <ul className="data-list">
        {t.rights.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <div className="section-title">{t.howTitle}</div>
      <ul className="data-list">
        {t.how.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <div style={{ height: 'var(--sp-4)' }} />
      <button className="btn" disabled={busy !== null} onClick={download}>
        <Icon name="book" /> {busy === 'export' ? 'Собираю…' : 'Скачать мои данные'}
      </button>

      <div style={{ height: 'var(--sp-2)' }} />
      {!preview ? (
        <button className="btn ghost" disabled={busy !== null} onClick={askDelete}>
          <Icon name="trash" /> {busy === 'preview' ? 'Считаю…' : 'Удалить мои данные'}
        </button>
      ) : (
        <div className="card warn-card">
          <div className="t-sm" style={{ fontWeight: 700, marginBottom: 'var(--sp-2)' }}>
            Что исчезнет
          </div>
          {/* сначала словами: «7 книг» человек прочтёт как «7 книг удалят», а
              книги остаются у него дома и просто уходят из каталога */}
          <ul className="data-list" style={{ marginBottom: 'var(--sp-3)' }}>
            {preview.effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <div className="retention">
            {Object.entries(preview.summary)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => (
                <div className="retention-row" key={k}>
                  <span className="w">{k.replace(/_/g, ' ')}</span>
                  <span className="h">{v}</span>
                </div>
              ))}
          </div>
          <div className="d muted" style={{ margin: 'var(--sp-3) 0' }}>
            Отменить это будет нельзя.
          </div>
          <button className="btn" disabled={busy !== null} onClick={reallyDelete}>
            {busy === 'delete' ? 'Удаляю…' : 'Да, удалить навсегда'}
          </button>
          <div style={{ height: 'var(--sp-2)' }} />
          <button className="btn ghost" disabled={busy !== null} onClick={() => setPreview(null)}>
            Передумал
          </button>
        </div>
      )}

      {blocked && (
        <div className="warn-banner" style={{ marginTop: 'var(--sp-3)' }}>
          Сейчас удалить не получится: у вас есть незакрытая выдача. Пока чужая книга у вас на
          руках (или ваша у кого-то), запись о ней нужна обеим сторонам.
          <button
            className="link-row"
            onClick={() => {
              haptic()
              go({ name: 'loans' })
            }}
          >
            Открыть «Мои книги на руках»
          </button>
        </div>
      )}
    </>
  )
}

/** Реквизит контролёра: либо значение, либо честная пометка «ещё не заполнено». */
function Field({ value, note }: { value: string; note: string }) {
  if (isPlaceholder(value)) {
    return (
      <div className="d" style={{ color: 'var(--warn)' }}>
        {note}
      </div>
    )
  }
  return <div className="t-sm">{value}</div>
}
