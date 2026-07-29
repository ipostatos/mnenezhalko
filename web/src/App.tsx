import { useEffect, useState } from 'react'
import { api } from './api'
import { backButton, onAppShow } from './telegram'
import type { Health, LoanSummary, Me } from './types'
import { Home } from './screens/Home'
import { Library } from './screens/Library'
import { BookView } from './screens/BookView'
import { Assistant } from './screens/Assistant'
import { Cities } from './screens/Cities'
import { Events } from './screens/Events'
import { Market } from './screens/Market'
import { AddBook } from './screens/AddBook'
import { Shelf } from './screens/Shelf'
import { MyShelf } from './screens/MyShelf'
import { BadgesScreen } from './screens/Badges'
import { Guide } from './screens/Guide'
import { MyData } from './screens/MyData'
import { Admin } from './screens/Admin'
import { Digest } from './screens/Digest'
import { Loans } from './screens/Loans'
import { About } from './screens/About'

export type Route =
  | { name: 'home' }
  | { name: 'library'; genre?: string; kind?: string }
  | { name: 'book'; id: string }
  | { name: 'ai' }
  | { name: 'cities' }
  | { name: 'events' }
  | { name: 'market' }
  | { name: 'add' }
  | { name: 'digest' }
  | { name: 'loans' }
  | { name: 'about' }
  | { name: 'shelf'; id: string }
  | { name: 'myshelf' }
  | { name: 'badges' }
  | { name: 'guide' }
  | { name: 'mydata' }
  | { name: 'admin' }

/**
 * Бот открывает Mini App сразу на нужном экране: `?screen=add|loans|digest`,
 * а `?screen=book&id=<id>` — прямо на карточке книги (так ведёт письмо
 * «книга освободилась», issue #10).
 */
function initialStack(): Route[] {
  const params = new URLSearchParams(window.location.search)
  const screen = params.get('screen')
  const id = params.get('id')
  if (screen === 'book' && id) return [{ name: 'home' }, { name: 'book', id }]
  const known = ['add', 'loans', 'digest', 'about', 'myshelf', 'badges', 'guide', 'mydata', 'admin'] as const
  return known.includes(screen as (typeof known)[number])
    ? [{ name: 'home' }, { name: screen } as Route]
    : [{ name: 'home' }]
}

export function App() {
  const [stack, setStack] = useState<Route[]>(initialStack)
  const [me, setMe] = useState<Me | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [loans, setLoans] = useState<LoanSummary | null>(null)
  const route = stack[stack.length - 1]

  const go = (r: Route) => setStack((s) => [...s, r])
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))

  useEffect(() => {
    const refresh = () => {
      api.health().then(setHealth).catch(() => {})
      api.me().then(setMe).catch(() => {})
      api.loans().then((r) => setLoans(r.summary)).catch(() => {})
    }
    refresh()
    // вернулись из фона — подтянуть свежие данные вместо устаревших
    return onAppShow(refresh)
  }, [])

  useEffect(() => backButton(stack.length > 1, back), [stack.length])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [stack.length, route.name])

  const city = me?.user.city ?? undefined
  const setCity = (value: string | null) =>
    setMe((m) => (m ? { ...m, user: { ...m.user, city: value } } : m))

  switch (route.name) {
    case 'library':
      return <Library go={go} city={city} genre={route.genre} kind={route.kind} />
    case 'book':
      return <BookView id={route.id} go={go} />
    case 'ai':
      return <Assistant go={go} city={city} enabled={health?.ai ?? false} />
    case 'cities':
      return <Cities city={city} onPick={setCity} />
    case 'events':
      return <Events city={city} />
    case 'market':
      return <Market city={city} />
    case 'add':
      return <AddBook city={city} go={go} />
    case 'digest':
      return <Digest city={city} go={go} />
    case 'loans':
      return <Loans go={go} />
    case 'about':
      return <About go={go} health={health} />
    case 'shelf':
      return <Shelf id={route.id} go={go} />
    case 'myshelf':
      return <MyShelf go={go} city={city} />
    case 'badges':
      return <BadgesScreen />
    case 'guide':
      return <Guide go={go} />
    case 'mydata':
      return <MyData go={go} />
    // права проверяет сервер: экран без них покажет «только для админов»
    case 'admin':
      return <Admin />
    default:
      return <Home go={go} me={me} health={health} loans={loans} />
  }
}
