import { useState } from 'react'
import type { Route } from '../App'
import type { Health } from '../types'
import { openTg, openInvoice, haptic, showAlert, tg } from '../telegram'
import { api } from '../api'
import { Icon } from './Icon'

const MAIN_CHAT = 'https://t.me/+hlRk_HGIDcE4M2Vi'
const INSTAGRAM = 'https://www.instagram.com/mne_ne_zhalko_pl'
const GUIDE = 'https://mnenezhalko.notion.site/3fcdfa8ed57444d7ae2129bf5c0299f7'
const PROJECT = 'https://mnenezhalko.notion.site/in-Poland-e4f29a5687c449f79581add35f17791b'
const CURATOR = 'https://t.me/LizavetaZh'
const DONATE_BOT = 'https://t.me/mnenezhalkobot?start=donate'
// держать синхронно с DONATE_AMOUNTS на сервере (server/src/bot.ts)
const DONATE_AMOUNTS = [50, 150, 500]

/** О проекте: что это, как устроено и как участвовать. */
export function About({ go, health }: { go: (r: Route) => void; health: Health | null }) {
  const [donating, setDonating] = useState(0)
  const [thanked, setThanked] = useState(false)

  async function donate(amount: number) {
    // нативный счёт есть только внутри Telegram — иначе уводим в бота
    if (!tg?.initData || !tg?.openInvoice) return openTg(DONATE_BOT)
    if (donating) return
    setDonating(amount)
    try {
      const { link } = await api.donateLink(amount)
      const status = await openInvoice(link)
      if (status === 'paid') {
        haptic('success')
        setThanked(true)
      }
    } catch {
      showAlert('Не получилось открыть счёт. Попробуйте позже или через бота: /donate')
    } finally {
      setDonating(0)
    }
  }

  return (
    <>
      <img className="illus" src="/il/exchange.jpg" alt="" loading="lazy" />
      <div className="hero">
        <span className="logo">🌿</span>
        <h1>О проекте</h1>
      </div>

      <p className="lead">
        <b>Добро пожаловать в «МнеНеЖалко»!</b> 👋
      </p>
      <p className="lead">
        Мы создаем сообщество, где бумажные книги получают вторую жизнь, а люди – возможность
        читать, знакомиться и поддерживать друг друга, особенно в миграции 🐝
      </p>
      <p className="lead">
        Благодаря «МнеНеЖалко» можно найти книги на полках у других участников проекта, взять их
        почитать на время или обменяться навсегда. А наши встречи – это не только про обмен
        книгами, но и про душевное общение, обсуждение литературы и поиск новых друзей 🤗
      </p>

      {health && (
        <div className="stat-tiles">
          <div className="s">
            <div className="n">{health.books}</div>
            <div className="c">книг и игр</div>
          </div>
          <div className="s">
            <div className="n">{health.librarians}</div>
            <div className="c">библиотекарей</div>
          </div>
          <div className="s">
            <div className="n">9</div>
            <div className="c">городов</div>
          </div>
        </div>
      )}

      <div className="section-title">Как взять книгу</div>
      <ol className="steps">
        <li>
          Найдите книгу в библиотеке — поиском по названию и автору, фильтрами по городу, жанру и
          языку. Не знаете, чего хочется, — расскажите настроение помощнику, он подберёт.
        </li>
        <li>
          В карточке виден библиотекарь — человек, у которого книга стоит на полке, и его город с
          районом. Напишите ему напрямую в Telegram.
        </li>
        <li>
          Договоритесь, как удобно: встретиться, передать на встрече проекта или в городском чате.
          Сроки и условия — между вами двумя, проект в это не вмешивается.
        </li>
        <li>
          Прочитали — верните или обменяйтесь навсегда, если оба не против. Книга живёт дальше 🌿
        </li>
      </ol>

      <div className="section-title">Как стать библиотекарем</div>
      <p className="lead">
        Библиотекарь — это любой участник, который поделился своими книгами. Никаких обязательств:
        книга остаётся у вас дома, просто становится видна библиотекарям.
      </p>
      <p className="lead">
        Проще всего — сфотографировать обложку в приложении: название, автор, язык и жанр
        заполнятся сами, останется проверить и нажать «Поставить на полку». Карточка сразу попадёт
        и в поиск, и в общую таблицу проекта. Можно и по-старинке — заполнить поля руками.
      </p>
      <button className="btn ghost" onClick={() => go({ name: 'add' })}>
        📸 Добавить свою книгу
      </button>

      <div className="section-title">Что ещё есть в приложении</div>
      <div className="about-list">
        <div>
          <b>Новинки</b> — что появилось на полках за сутки и за месяц.
        </div>
        <div>
          <b>У кого моя книга</b> — записываете, кому отдали почитать, и бот сам помнит: сколько
          дней прошло и когда пора напомнить. Возврат отмечается одной кнопкой.
        </div>
        <div>
          <b>Встречи</b> — афиша по городам. Анонсы приходят в личку, если включены уведомления.
        </div>
        <div>
          <b>Барахолка</b> — отдам, продам, ищу: книжные полки, коробки, всё вокруг книг.
        </div>
        <div>
          <b>Города и чаты</b> — девять городов Польши, у каждого своя тема в общем чате.
        </div>
      </div>

      <div className="section-title">По-доброму</div>
      <div className="about-list">
        <div>Берегите чужую книгу так же, как свою любимую.</div>
        <div>Договорились о сроке — предупредите, если не успеваете.</div>
        <div>Книга не вернулась вовремя — обычно это просто жизнь, напомните по-доброму.</div>
        <div>Пишите библиотекарю по-человечески: кто вы, откуда узнали, когда удобно встретиться.</div>
      </div>

      <div className="section-title">Поддержать проект</div>
      <p className="lead">
        «МнеНеЖалко» некоммерческий и держится на энтузиазме. Если приложение пригодилось — можно
        сказать спасибо звёздами Telegram: они идут на домен, сервер и ИИ-подбор книг 🌿
      </p>
      {thanked ? (
        <div className="donate-thanks">🌿 Спасибо за поддержку! Вы очень помогаете проекту.</div>
      ) : (
        <div className="donate-row">
          {DONATE_AMOUNTS.map((a) => (
            <button
              key={a}
              className="btn ghost donate-btn"
              disabled={donating !== 0}
              onClick={() => donate(a)}
            >
              {donating === a ? '…' : `${a} ⭐`}
            </button>
          ))}
        </div>
      )}

      <div className="section-title">Куда идти дальше</div>
      <button className="row-card tile" style={{ ['--tone' as any]: '#6d7bb5' }} onClick={() => openTg(MAIN_CHAT)}>
        <div className="ic-tile">
          <Icon name="chat" />
        </div>
        <div className="grow">
          <div className="t">Чат проекта</div>
          <div className="d">Знакомства, вопросы, темы по городам</div>
        </div>
        <div className="chev">›</div>
      </button>
      <button className="row-card tile" style={{ ['--tone' as any]: '#d94a86' }} onClick={() => openTg(INSTAGRAM)}>
        <div className="ic-tile">
          <Icon name="instagram" />
        </div>
        <div className="grow">
          <div className="t">Инстаграм</div>
          <div className="d">@mne_ne_zhalko_pl</div>
        </div>
        <div className="chev">›</div>
      </button>
      <button className="row-card tile" style={{ ['--tone' as any]: '#e59429' }} onClick={() => openTg(GUIDE)}>
        <div className="ic-tile">
          <Icon name="compass" />
        </div>
        <div className="grow">
          <div className="t">Инструкция новичка</div>
          <div className="d">Как всё устроено в общей таблице проекта</div>
        </div>
        <div className="chev">›</div>
      </button>
      <button className="row-card tile" style={{ ['--tone' as any]: '#2f6db0' }} onClick={() => openTg(PROJECT)}>
        <div className="ic-tile">
          <Icon name="globe" />
        </div>
        <div className="grow">
          <div className="t">Страница проекта</div>
          <div className="d">Полная библиотека и правила в Notion</div>
        </div>
        <div className="chev">›</div>
      </button>
      <button className="row-card tile" style={{ ['--tone' as any]: '#d99a2b' }} onClick={() => openTg(CURATOR)}>
        <div className="ic-tile">
          <Icon name="crown" />
        </div>
        <div className="grow">
          <div className="t">Главный по книгам</div>
          <div className="d">@LizavetaZh</div>
        </div>
        <div className="chev">›</div>
      </button>
    </>
  )
}
