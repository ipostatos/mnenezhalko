import { useEffect, useState } from 'react'
import { api } from './api'
import { backButton } from './telegram'
import type { Health, Me } from './types'
import { Home } from './screens/Home'
import { Library } from './screens/Library'
import { BookView } from './screens/BookView'
import { Assistant } from './screens/Assistant'
import { Cities } from './screens/Cities'
import { Events } from './screens/Events'
import { Market } from './screens/Market'
import { AddBook } from './screens/AddBook'
import { Shelf } from './screens/Shelf'
import { Digest } from './screens/Digest'

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
  | { name: 'shelf'; id: string }

/** Бот открывает Mini App сразу на нужном экране: `?screen=add`. */
function initialStack(): Route[] {
  const screen = new URLSearchParams(window.location.search).get('screen')
  return screen === 'add' ? [{ name: 'home' }, { name: 'add' }] : [{ name: 'home' }]
}

export function App() {
  const [stack, setStack] = useState<Route[]>(initialStack)
  const [me, setMe] = useState<Me | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const route = stack[stack.length - 1]

  const go = (r: Route) => setStack((s) => [...s, r])
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))

  useEffect(() => {
    api.health().then(setHealth).catch(() => {})
    api.me().then(setMe).catch(() => {})
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
    case 'shelf':
      return <Shelf id={route.id} go={go} />
    default:
      return <Home go={go} me={me} health={health} />
  }
}
