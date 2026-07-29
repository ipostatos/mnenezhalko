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
  Compass,
  Globe,
  Crown,
  Coffee,
  Pencil,
  Trash2,
  RotateCcw,
  EyeOff,
  Flower2,
  Award,
  Sprout,
  ShieldCheck,
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
  | 'instagram'
  | 'compass'
  | 'globe'
  | 'crown'
  | 'coffee'
  | 'edit'
  | 'trash'
  | 'refresh'
  | 'hide'
  | 'flower'
  | 'award'
  | 'sprout'
  | 'shield'

const MAP: Record<Exclude<IconName, 'instagram'>, LucideIcon> = {
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
  compass: Compass,
  globe: Globe,
  crown: Crown,
  coffee: Coffee,
  edit: Pencil,
  trash: Trash2,
  refresh: RotateCcw,
  hide: EyeOff,
  flower: Flower2,
  award: Award,
  sprout: Sprout,
  shield: ShieldCheck,
}

/** Instagram в lucide v1 убрали (бренд) — берём выверенную геометрию Feather. */
function InstagramIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={24}
      height={24}
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37Z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  )
}

export function Icon({ name }: { name: IconName }) {
  if (name === 'instagram') return <InstagramIcon />
  const C = MAP[name]
  return <C strokeWidth={1.75} absoluteStrokeWidth aria-hidden />
}
