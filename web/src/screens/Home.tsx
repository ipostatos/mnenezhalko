import type { Route } from '../App'
import type { Health, LoanSummary, Me } from '../types'
import { haptic, openTg } from '../telegram'
import { MoodBoard } from './MoodBoard'
import { Icon, type IconName } from './Icon'

const MAIN_CHAT = 'https://t.me/+hlRk_HGIDcE4M2Vi'
const INSTAGRAM = 'https://www.instagram.com/mne_ne_zhalko_pl'

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
    {
      icon: 'book',
      tone: 'var(--accent)',
      title: 'Библиотека',
      sub: health ? `${health.books} книг и игр у соседей` : 'Поиск по полкам проекта',
      route: { name: 'library' },
    },
    {
      icon: 'wand',
      tone: '#a48fd0',
      title: 'Подобрать книгу',
      sub: 'Расскажите, чего хочется — найду',
      route: { name: 'ai' },
    },
    {
      icon: 'sparkle',
      tone: '#e0a44a',
      title: 'Новинки',
      sub: 'Что появилось за сутки и за месяц',
      route: { name: 'digest' },
    },
    {
      icon: 'pin',
      tone: '#8fae86',
      title: 'Города и чаты',
      sub: me?.user.city ? `Ваш город: ${me.user.city}` : 'Выберите свой город',
      route: { name: 'cities' },
    },
    {
      icon: 'calendar',
      tone: '#6f9fc4',
      title: 'Ближайшие встречи',
      sub: 'Что и когда происходит рядом',
      route: { name: 'events' },
    },
    {
      icon: 'tag',
      tone: '#d98a62',
      title: 'Барахолка',
      sub: 'Отдам, продам, ищу — по городам',
      route: { name: 'market' },
    },
    {
      icon: 'bookHeart',
      tone: '#d98aa0',
      title: 'У кого моя книга',
      sub: 'Кому отдали почитать и когда ждать назад',
      route: { name: 'loans' },
    },
    {
      icon: 'shelf',
      tone: '#6a8caf',
      title: 'Моя полка',
      sub: 'Мои книги, статусы, редактирование',
      route: { name: 'myshelf' },
    },
    {
      icon: 'plus',
      tone: 'var(--accent)',
      title: 'Добавить книгу',
      sub: 'Поставить свою книгу на полку',
      route: { name: 'add' },
    },
    {
      icon: 'leaf',
      tone: '#7bb37a',
      title: 'О проекте',
      sub: 'Как всё устроено и с чего начать',
      route: { name: 'about' },
    },
    {
      icon: 'chat',
      tone: '#8a94a0',
      title: 'Чат проекта',
      sub: 'МнеНеЖалко в Польше',
      url: MAIN_CHAT,
    },
    {
      icon: 'camera',
      tone: '#d95c8a',
      title: 'Инстаграм',
      sub: '@mne_ne_zhalko_pl',
      url: INSTAGRAM,
    },
  ]

  return (
    <>
      <MoodBoard summary={loans} onOpen={() => go({ name: 'loans' })} />

      <div className="hero">
        <span className="logo">🌿</span>
        <h1>МнеНеЖалко</h1>
      </div>
      <div className="sub">Книжный обмен между своими — в Польше</div>

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

      <button className="promo" onClick={() => { haptic(); go({ name: 'add' }) }}>
        <img src="/il/girl-book.jpg" alt="" loading="lazy" />
        <div className="grow">
          <div className="t">Поделись книгой</div>
          <div className="d">Поставь свою книгу на полку — подари кому-то вдохновение 🐝</div>
        </div>
        <div className="chev">›</div>
      </button>

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
