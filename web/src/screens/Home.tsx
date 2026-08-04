import type { Route } from '../App'
import type { Health, LoanSummary, Me } from '../types'
import { haptic, openTg } from '../telegram'
import { MAIN_CHAT, INSTAGRAM } from '../links'
import { MoodBoard } from './MoodBoard'
import { Icon, type IconName } from './Icon'

type Tile = {
  icon: IconName
  tone: string
  title: string
  sub: string
  route?: Route
  url?: string
}

export function Home({
  go,
  me,
  health,
  loans,
}: {
  go: (r: Route) => void
  me: Me | null
  health: Health | null
  loans: LoanSummary | null
}) {
  const tiles: Tile[] = [
    // «О проекте» стоит первой: человек, попавший сюда впервые, сначала должен
    // понять, куда попал, и только потом идти в каталог (просьба user 29.07.2026)
    {
      icon: 'leaf',
      tone: '#30A46C',
      title: 'О проекте',
      sub: 'Как всё устроено и с чего начать',
      route: { name: 'about' },
    },
    {
      icon: 'book',
      tone: '#8DA4EF',
      title: 'Библиотека',
      sub: health ? `${health.books} книг и игр у библиотекарей` : 'Поиск по полкам проекта',
      route: { name: 'library' },
    },
    {
      icon: 'wand',
      tone: '#DD93C2',
      title: 'Подобрать книгу',
      sub: 'Расскажите, чего хочется — найду',
      route: { name: 'ai' },
    },
    {
      icon: 'sparkle',
      tone: '#E2A336',
      title: 'Новинки',
      sub: 'Что появилось за сутки и за месяц',
      route: { name: 'digest' },
    },
    // «Города и чаты» отдельной плашкой больше нет: на дашборде счётчики
    // «библиотекарей» и «городов» ведут ровно туда же, и плашка была третьим
    // входом в один экран (просьба user 4.08.2026). Экран на месте, из главной
    // в него ведут счётчики; выбор своего города — там же
    {
      icon: 'calendar',
      tone: '#5BB98B',
      title: 'Ближайшие встречи',
      sub: 'Что и когда происходит рядом',
      route: { name: 'events' },
    },
    // адрес клуба приходит с сервера (CLUB_URL) — одна точка правды с меню бота,
    // поэтому плашку показываем только когда health уже пришёл
    ...(health?.clubUrl
      ? ([
          {
            icon: 'flower',
            tone: '#DD93C2',
            title: 'Книжная Клумба',
            sub: 'Книжный клуб проекта — чат в Telegram',
            url: health.clubUrl,
          },
        ] as Tile[])
      : []),
    {
      icon: 'tag',
      tone: '#EC8E7B',
      title: 'Барахолка',
      sub: 'Отдам, продам, ищу — по городам',
      route: { name: 'market' },
    },
    {
      icon: 'bookHeart',
      tone: '#8DA4EF',
      title: 'У кого моя книга',
      sub: 'Кому отдали почитать и когда ждать назад',
      route: { name: 'loans' },
    },
    // «Мои достижения» с главной убраны (просьба user 4.08.2026): значки —
    // не то, ради чего человек открывает приложение. Экран `badges` на месте,
    // вход в него — лентой значков на «Моей полке» и из инструкции новичка
    {
      icon: 'shelf',
      tone: '#5BB98B',
      title: 'Моя полка',
      sub: 'Мои книги, статусы, редактирование',
      route: { name: 'myshelf' },
    },
    {
      icon: 'plus',
      tone: '#EC9455',
      title: 'Добавить книгу',
      sub: 'Поставить свою книгу на полку',
      route: { name: 'add' },
    },
    // разбор виден только админам: остальным эта плашка ничего не даст, а права
    // всё равно проверяет сервер на каждой ручке (см. moderation.ts)
    ...(me?.user.isAdmin
      ? ([
          {
            icon: 'shield',
            tone: '#5BB98B',
            title: 'Разбор',
            sub: 'Книги на проверке, жалобы, ограничения',
            route: { name: 'admin' },
          },
        ] as Tile[])
      : []),
    {
      icon: 'chat',
      tone: '#8DA4EF',
      title: 'Чат проекта',
      sub: 'МнеНеЖалко в Польше',
      url: MAIN_CHAT,
    },
    {
      icon: 'instagram',
      tone: '#DD93C2',
      title: 'Инстаграм',
      sub: '@mne_ne_zhalko_pl',
      url: INSTAGRAM,
    },
  ]

  return (
    <>
      <div className="hero">
        <span className="logo">🌿</span>
        <h1>МнеНеЖалко</h1>
      </div>
      <div className="sub">Книжный обмен между своими — в Польше</div>

      <button className="promo" onClick={() => { haptic(); go({ name: 'add' }) }}>
        <img src="/il/girl-book.jpg" alt="" loading="lazy" />
        <div className="grow">
          <div className="t">Поделись книгой</div>
          <div className="d">Поставь свою книгу на полку — подари кому-то вдохновение 🐝</div>
        </div>
        <div className="chev">›</div>
      </button>

      {health && (
        <div className="stat-tiles">
          {/* счётчики ведут в свои разделы — раньше были некликабельными div */}
          <button
            className="s"
            aria-label={`Открыть библиотеку: ${health.books} книг и игр`}
            onClick={() => { haptic(); go({ name: 'library' }) }}
          >
            <div className="n">{health.books}</div>
            <div className="c">книг и игр</div>
          </button>
          <button
            className="s"
            aria-label={`Города и библиотекари: ${health.librarians}`}
            onClick={() => { haptic(); go({ name: 'cities' }) }}
          >
            <div className="n">{health.librarians}</div>
            <div className="c">библиотекарей</div>
          </button>
          <button
            className="s"
            aria-label={`Города проекта: ${health.cities ?? 9}`}
            onClick={() => { haptic(); go({ name: 'cities' }) }}
          >
            <div className="n">{health.cities ?? 9}</div>
            <div className="c">городов</div>
          </button>
        </div>
      )}

      <MoodBoard summary={loans} onOpen={() => go({ name: 'loans' })} />

      {/* блок «Польза сообщества» с главной убран (просьба user 4.08.2026).
          Компонент Impact и ручка /api/impact живы — вернуть можно одной строкой */}

      <div className="section-title">Что можно сделать</div>
      {tiles.map((t) => (
        <button
          key={t.title}
          className="row-card tile"
          style={{ ['--tone' as any]: t.tone }}
          onClick={() => {
            haptic()
            if (t.url) openTg(t.url)
            else if (t.route) go(t.route)
          }}
        >
          <div className="ic-tile">
            <Icon name={t.icon} />
          </div>
          <div className="grow">
            <div className="t">{t.title}</div>
            <div className="d">{t.sub}</div>
          </div>
          <div className="chev">›</div>
        </button>
      ))}

      <div className="foot">
        Проект, где каждый может стать библиотекарем 🌿
        <br />
        Главный по книгам —{' '}
        <button className="foot-link" onClick={() => openTg('https://t.me/LizavetaZh')}>
          @LizavetaZh
        </button>
      </div>
    </>
  )
}
