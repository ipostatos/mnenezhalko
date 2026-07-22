import type { Route } from '../App'
import type { Health, Me } from '../types'
import { haptic, openTg } from '../telegram'

const MAIN_CHAT = 'https://t.me/+hlRk_HGIDcE4M2Vi'
const INSTAGRAM = 'https://www.instagram.com/mne_ne_zhalko_pl'

type Tile = {
  icon: string
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
}: {
  go: (r: Route) => void
  me: Me | null
  health: Health | null
}) {
  const tiles: Tile[] = [
    {
      icon: '📚',
      tone: 'var(--accent)',
      title: 'Библиотека',
      sub: health ? `${health.books} книг и игр у соседей` : 'Поиск по полкам проекта',
      route: { name: 'library' },
    },
    {
      icon: '🤖',
      tone: '#a77bf0',
      title: 'Подобрать книгу',
      sub: 'Расскажите, чего хочется — найду',
      route: { name: 'ai' },
    },
    {
      icon: '🆕',
      tone: '#5ac8d8',
      title: 'Новинки',
      sub: 'Что появилось за сутки и за месяц',
      route: { name: 'digest' },
    },
    {
      icon: '🏙',
      tone: '#4caf72',
      title: 'Города и чаты',
      sub: me?.user.city ? `Ваш город: ${me.user.city}` : 'Выберите свой город',
      route: { name: 'cities' },
    },
    {
      icon: '📅',
      tone: '#e0a13a',
      title: 'Ближайшие встречи',
      sub: 'Что и когда происходит рядом',
      route: { name: 'events' },
    },
    {
      icon: '🛍',
      tone: '#e5544b',
      title: 'Барахолка',
      sub: 'Отдам, продам, ищу — по городам',
      route: { name: 'market' },
    },
    {
      icon: '📕',
      tone: '#c98a3a',
      title: 'У кого моя книга',
      sub: 'Кому отдали почитать и когда ждать назад',
      route: { name: 'loans' },
    },
    {
      icon: '➕',
      tone: '#50a8eb',
      title: 'Добавить книгу',
      sub: 'Поставить свою книгу на полку',
      route: { name: 'add' },
    },
    {
      icon: '🌿',
      tone: '#7bb37a',
      title: 'О проекте',
      sub: 'Как всё устроено и с чего начать',
      route: { name: 'about' },
    },
    {
      icon: '💬',
      tone: '#8a9aa9',
      title: 'Чат проекта',
      sub: 'МнеНеЖалко в Польше',
      url: MAIN_CHAT,
    },
    {
      icon: '📸',
      tone: '#d95c8a',
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

      <div className="section-title">Что можно сделать</div>
      {tiles.map((t) => (
        <button
          key={t.title}
          className="row-card"
          onClick={() => {
            haptic()
            if (t.url) openTg(t.url)
            else if (t.route) go(t.route)
          }}
        >
          <div className="ic-tile" style={{ ['--tone' as any]: t.tone }}>
            {t.icon}
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
