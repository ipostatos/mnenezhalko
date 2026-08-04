/**
 * Текст о персональных данных — по-русски и по-польски.
 *
 * Реквизиты контролёра заполнены по решению user 4.08.2026: контролёр — частное
 * лицо, поэтому показываем имя и почту для связи, почтовый адрес не публикуем.
 * Имя пишется одинаково в обеих версиях текста и не транслитерируется.
 *
 * Заполняется в одном месте: константы ниже. Пока значение начинается с «{{»,
 * приложение считает его незаполненным и не рисует строку.
 */
export const CONTROLLER = {
  name: 'Baryshau Artsiom',
  address: '{{DATA_CONTROLLER_ADDRESS}}',
  email: 'ipostatos@gmail.com',
}

/** Значение ещё не подставлено — показываем как пробел, а не как текст. */
export const isPlaceholder = (v: string) => v.trim().startsWith('{{')

export type PrivacyLang = 'ru' | 'pl'

export type PrivacySection = { title: string; items: string[] }

export type PrivacyText = {
  title: string
  updated: string
  intro: string
  controllerTitle: string
  controllerNote: string
  /** Подписи к реквизитам — показываются только у заполненных. */
  controllerFields: { name: string; address: string; email: string }
  sections: PrivacySection[]
  retentionTitle: string
  retentionNote: string
  retention: [string, string][]
  rightsTitle: string
  rights: string[]
  howTitle: string
  how: string[]
  placeholderNote: string
}

const RETENTION_RU: [string, string][] = [
  ['Профиль, пока вы пользуетесь приложением', 'до удаления вами'],
  ['Профиль без книг, выдач и очередей, если вы не заходите', '12 месяцев, затем удаление'],
  ['Незакрытая выдача', 'до возврата книги'],
  ['Закрытая выдача и её события', '24 месяца, затем обезличивание'],
  ['Очередь на книгу: активная', 'до выхода, приглашения или истечения срока'],
  ['Очередь на книгу: закрытая', '30 дней'],
  ['Отзыв', 'пока вы его не удалите'],
  ['Удалённый отзыв', '30 дней, затем удаление насовсем'],
  ['Жалобы на отзыв', 'пока идёт разбор и 12 месяцев после'],
  ['Ограничения и блокировки', 'пока действуют; запись о снятом остаётся в истории решений'],
  ['Решения модераторов (журнал)', '12 месяцев, затем удаление'],
  ['Уведомление о решении', '30 дней после отправки'],
  ['Фотография, присланная для распознавания', 'до сохранения книги, не дольше 7 дней'],
  ['Фотография, которую так и не привязали к книге', '48 часов'],
  ['Обложка опубликованной книги', 'пока книга на полке и 90 дней после'],
  ['Технические записи о запросах и ошибках', '30 дней'],
  ['Записи о попытках злоупотреблений', '90 дней'],
  ['Файл выгрузки ваших данных', '24 часа'],
  ['Резервные копии', 'скользящее окно 30 дней'],
]

const RETENTION_PL: [string, string][] = [
  ['Profil, dopóki korzystasz z aplikacji', 'do usunięcia przez Ciebie'],
  ['Profil bez książek, wypożyczeń i kolejek, jeśli nie logujesz się', '12 miesięcy, potem usunięcie'],
  ['Otwarte wypożyczenie', 'do zwrotu książki'],
  ['Zamknięte wypożyczenie i jego zdarzenia', '24 miesiące, potem anonimizacja'],
  ['Kolejka do książki: aktywna', 'do wyjścia, zaproszenia lub wygaśnięcia'],
  ['Kolejka do książki: zamknięta', '30 dni'],
  ['Opinia', 'dopóki jej nie usuniesz'],
  ['Usunięta opinia', '30 dni, potem usunięcie trwałe'],
  ['Zgłoszenia opinii', 'czas rozpatrywania i 12 miesięcy po'],
  ['Ograniczenia i blokady', 'dopóki obowiązują; zapis o zdjętym zostaje w historii decyzji'],
  ['Decyzje moderatorów (dziennik)', '12 miesięcy, potem usunięcie'],
  ['Powiadomienie o decyzji', '30 dni po wysłaniu'],
  ['Zdjęcie przesłane do rozpoznania', 'do zapisania książki, nie dłużej niż 7 dni'],
  ['Zdjęcie niepowiązane z żadną książką', '48 godzin'],
  ['Okładka opublikowanej książki', 'dopóki książka jest na półce i 90 dni po'],
  ['Techniczne zapisy o żądaniach i błędach', '30 dni'],
  ['Zapisy o próbach nadużyć', '90 dni'],
  ['Plik z eksportem Twoich danych', '24 godziny'],
  ['Kopie zapasowe', 'okno przesuwne 30 dni'],
]

export const PRIVACY: Record<PrivacyLang, PrivacyText> = {
  ru: {
    title: 'Ваши данные',
    updated: 'Обновлено 30 июля 2026',
    intro:
      'Проект «МнеНеЖалко» — книжный обмен между своими. Чтобы книга нашла человека, ' +
      'нам приходится хранить немного данных о вас. Здесь честно написано, каких именно, ' +
      'зачем и на сколько.',
    controllerTitle: 'Кто отвечает за ваши данные',
    controllerNote:
      'Это тот, кто решает, зачем и как данные обрабатываются, и кому вы пишете по любому ' +
      'вопросу о них.',
    controllerFields: { name: 'Кто', address: 'Адрес', email: 'Почта для писем' },
    sections: [
      {
        title: 'Что мы храним',
        items: [
          'Ваш Telegram: числовой id, ник и имя — по ним приложение узнаёт вас без пароля.',
          'Город и район, если вы их указали, — чтобы показывать книги рядом с вами.',
          'Ваши книги: название, автор, жанр, язык, обложка.',
          'Выдачи: кому вы дали книгу и когда её вернули, и наоборот.',
          'Очереди: каких занятых книг вы ждёте.',
          'Оценки и отзывы, которые вы оставили.',
          'Фотографии, которые вы присылаете, чтобы распознать книгу.',
          'Ограничения и блокировки, если они у вас есть: что закрыто, почему и до какого числа.',
          'Технические записи о запросах к серверу и об ошибках.',
        ],
      },
      {
        title: 'Зачем',
        items: [
          'Чтобы приложение работало: показывало вашу полку, ваши выдачи и напоминало о возврате.',
          'Чтобы люди могли договориться о книге напрямую в Telegram.',
          'Чтобы каталог оставался осмысленным: модерация, борьба со спамом и злоупотреблениями.',
          'Чтобы мы понимали, живо ли приложение, и чинили поломки.',
        ],
      },
      {
        title: 'Кто ещё видит эти данные',
        items: [
          'Другие участники проекта: ваше имя и ник рядом с вашими книгами и отзывами, ' +
            'а также город. Числовой Telegram id не показывается никому и никогда.',
          'Telegram — как площадка, через которую вы пользуетесь ботом и приложением.',
          'Notion — общая таблица книг проекта: туда уходят книга, город и контакт владельца. ' +
            'Отзывы и выдачи туда не уходят.',
          'Anthropic — если вы попросили подобрать книгу или распознать обложку: ' +
            'уходит только ваш запрос или фотография, без вашего имени и id.',
          'Сервер и резервные копии находятся в Европейском союзе.',
        ],
      },
    ],
    retentionTitle: 'Сколько храним',
    retentionNote:
      'Мы храним данные, пока они нужны для перечисленных выше целей, и не дольше. ' +
      'Сроки ниже — правило, по которому приложение чистит их само.',
    retention: RETENTION_RU,
    rightsTitle: 'Ваши права',
    rights: [
      'Посмотреть и забрать свои данные одним файлом.',
      'Исправить их: имя, ник и город правятся прямо в приложении.',
      'Удалить свои данные.',
      'Возразить против обработки или потребовать её ограничить.',
      'Пожаловаться в орган по защите данных (в Польше — Prezes UODO).',
    ],
    howTitle: 'Как этим воспользоваться',
    how: [
      'Выгрузка и удаление — кнопками на этом экране, сразу и без переписки. ' +
        'Файл с вашими данными бот пришлёт в чат с вами.',
      'Незакрытая выдача удаление задерживает: пока чужая книга у вас на руках (или ваша у ' +
        'кого-то), запись о ней нужна обеим сторонам. Сначала возврат.',
      'Закрытые выдачи после удаления остаются в истории обмена, но опознать в них вас уже нельзя.',
      'Решения модераторов остаются в служебном журнале как факт, но без вашего имени, ника и ' +
        'номера: по ним нельзя понять, что это были вы.',
      'По остальным вопросам пишите контролёру данных по адресу выше.',
    ],
    placeholderNote: 'Реквизиты ещё не заполнены',
  },
  pl: {
    title: 'Twoje dane',
    updated: 'Zaktualizowano 30 lipca 2026',
    intro:
      'Projekt „МнеНеЖалко” to wymiana książek między swoimi. Żeby książka trafiła do ' +
      'człowieka, przechowujemy o Tobie trochę danych. Tutaj uczciwie napisane, jakich, ' +
      'po co i jak długo.',
    controllerTitle: 'Kto odpowiada za Twoje dane',
    controllerNote:
      'To osoba lub podmiot, który decyduje, po co i jak dane są przetwarzane, i do którego ' +
      'piszesz w każdej sprawie ich dotyczącej.',
    controllerFields: { name: 'Kto', address: 'Adres', email: 'E-mail' },
    sections: [
      {
        title: 'Co przechowujemy',
        items: [
          'Twój Telegram: numeryczne id, nazwę użytkownika i imię — dzięki nim aplikacja Cię rozpoznaje bez hasła.',
          'Miasto i dzielnicę, jeśli je podasz — żeby pokazywać książki blisko Ciebie.',
          'Twoje książki: tytuł, autora, gatunek, język, okładkę.',
          'Wypożyczenia: komu dałeś książkę i kiedy wróciła, oraz odwrotnie.',
          'Kolejki: na które zajęte książki czekasz.',
          'Oceny i opinie, które zostawiłeś.',
          'Zdjęcia przesyłane po to, żeby rozpoznać książkę.',
          'Ograniczenia i blokady, jeśli Cię dotyczą: co zostało zamknięte, dlaczego i do kiedy.',
          'Techniczne zapisy o żądaniach do serwera i o błędach.',
        ],
      },
      {
        title: 'Po co',
        items: [
          'Żeby aplikacja działała: pokazywała Twoją półkę i wypożyczenia oraz przypominała o zwrocie.',
          'Żeby ludzie mogli umówić się o książkę bezpośrednio w Telegramie.',
          'Żeby katalog pozostał sensowny: moderacja, walka ze spamem i nadużyciami.',
          'Żebyśmy wiedzieli, czy aplikacja działa, i naprawiali awarie.',
        ],
      },
      {
        title: 'Kto jeszcze widzi te dane',
        items: [
          'Inni uczestnicy projektu: Twoje imię i nazwa użytkownika przy Twoich książkach i ' +
            'opiniach oraz miasto. Numeryczne id Telegrama nie jest pokazywane nikomu.',
          'Telegram — jako platforma, przez którą korzystasz z bota i aplikacji.',
          'Notion — wspólna tabela książek projektu: trafia tam książka, miasto i kontakt ' +
            'właściciela. Opinie i wypożyczenia tam nie trafiają.',
          'Anthropic — jeśli poprosisz o dobór książki lub rozpoznanie okładki: wysyłane jest ' +
            'tylko Twoje zapytanie lub zdjęcie, bez imienia i id.',
          'Serwer i kopie zapasowe znajdują się w Unii Europejskiej.',
        ],
      },
    ],
    retentionTitle: 'Jak długo przechowujemy',
    retentionNote:
      'Przechowujemy dane tak długo, jak są potrzebne do powyższych celów, i nie dłużej. ' +
      'Poniższe terminy to reguła, według której aplikacja czyści je sama.',
    retention: RETENTION_PL,
    rightsTitle: 'Twoje prawa',
    rights: [
      'Zobaczyć i pobrać swoje dane w jednym pliku.',
      'Poprawić je: imię, nazwę użytkownika i miasto zmienisz w aplikacji.',
      'Usunąć swoje dane.',
      'Sprzeciwić się przetwarzaniu lub żądać jego ograniczenia.',
      'Złożyć skargę do organu nadzorczego (w Polsce — Prezes UODO).',
    ],
    howTitle: 'Jak z tego skorzystać',
    how: [
      'Eksport i usunięcie — przyciskami na tym ekranie, od razu i bez korespondencji. ' +
        'Plik z Twoimi danymi bot przyśle na czat z Tobą.',
      'Otwarte wypożyczenie wstrzymuje usunięcie: dopóki cudza książka jest u Ciebie (albo ' +
        'Twoja u kogoś), zapis o niej jest potrzebny obu stronom. Najpierw zwrot.',
      'Zamknięte wypożyczenia po usunięciu zostają w historii wymiany, ale nie da się w nich ' +
        'Ciebie rozpoznać.',
      'Decyzje moderatorów zostają w dzienniku służbowym jako fakt, ale bez Twojego imienia, ' +
        'nazwy użytkownika i numeru: nie da się z nich wywnioskować, że chodziło o Ciebie.',
      'W pozostałych sprawach pisz do administratora danych pod adres powyżej.',
    ],
    placeholderNote: 'Dane administratora nie zostały jeszcze uzupełnione',
  },
}
