/**
 * Иконки под фирменный стиль — готовый набор Lucide (MIT), тонкие линейные,
 * бандлятся в приложение (без внешних CDN). Обёртка сохраняет прежний API
 * <Icon name="…" />: цвет из .ic-tile через currentColor, размер задаёт CSS.
 */
import {
  BookOpen,
  Wand2,
  Sparkles,
  MapPin,
  CalendarDays,
  Tag,
  BookHeart,
  Library,
  PlusCircle,
  Leaf,
  MessageCircle,
  Camera,
  type LucideIcon,
} from 'lucide-react'

export type IconName =
  | 'book'
  | 'wand'
  | 'sparkle'
  | 'pin'
  | 'calendar'
  | 'tag'
  | 'bookHeart'
  | 'shelf'
  | 'plus'
  | 'leaf'
  | 'chat'
  | 'camera'

const MAP: Record<IconName, LucideIcon> = {
  book: BookOpen,
  wand: Wand2,
  sparkle: Sparkles,
  pin: MapPin,
  calendar: CalendarDays,
  tag: Tag,
  bookHeart: BookHeart,
  shelf: Library,
  plus: PlusCircle,
  leaf: Leaf,
  chat: MessageCircle,
  camera: Camera,
}

export function Icon({ name }: { name: IconName }) {
  const C = MAP[name]
  return <C strokeWidth={1.75} absoluteStrokeWidth aria-hidden />
}
