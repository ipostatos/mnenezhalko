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

  // реквизиты контролёра: показываем только заполненные (см. privacy-text.ts)
  const filled = (
    [
      [t.controllerFields.name, CONTROLLER.name],
      [t.controllerFields.address, CONTROLLER.address],
      [t.controllerFields.email, CONTROLLER.email],
    ] as [string, string][]
  ).filter(([, v]) => !isPlaceholder(v))

  const [busy, setBusy] = useState<'export' | 'preview' | 'delete' | null>(null)
  const [preview, setPreview] = useState<{ summary: Record<string, number>; effects: string[] } | null>(null)
  const [blocked, setBlocked] = useState<{ title: string; role: string }[] | null>(null)
  const [done, setDone] = useState(false)

  /**
   * Выгрузка приходит файлом в чат с ботом.
   *
   * Раньше файл собирался прямо здесь и скачивался blob-ссылкой — в вебвью
   * Telegram это подвешивало приложение намертво, обновление не помогало
   * (жалоба user 4.08.2026). Бот шлёт файл в чат: сохранить, переслать и
   * открыть его человек сможет обычными средствами Telegram.
   */
  async function download() {
    haptic()
    setBusy('export')
    try {
      await api.sendMyData()
      showAlert('Файл с вашими данными отправлен в чат с ботом.')
    } catch (e: any) {
      if (e?.message === 'too_many') {
        showAlert('Слишком часто. Попробуйте через час.')
      } else {
        // бот не смог прислать файл (например, вы его заблокировали) — тогда
        // хотя бы отдадим данные в буфер обмена, чтобы право не осталось на бумаге
        try {
          const data = await api.exportMyData()
          await navigator.clipboard.writeText(JSON.stringify(data, null, 2))
          showAlert('Бот не смог прислать файл, поэтому данные скопированы в буфер обмена.')
        } catch {
          showAlert('Не получилось собрать выгрузку. Попробуйте позже или напишите нам.')
        }
      }
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
        {/* показываем только заполненные реквизиты: пустая строка «ещё не
            заполнено» рядом с именем выглядела бы как поломка, а не как пробел.
            Если не заполнено ничего — одна честная строка вместо трёх */}
        {filled.length === 0 ? (
          <div className="d warn-text">{t.placeholderNote}</div>
        ) : (
          <div className="controller">
            {filled.map(([label, value]) => (
              <div className="controller-row" key={label}>
                <span className="w">{label}</span>
                <span className="v">{value}</span>
              </div>
            ))}
          </div>
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
        <Icon name="book" /> {busy === 'export' ? 'Собираю…' : 'Прислать мои данные файлом'}
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
