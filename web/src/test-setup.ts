/**
 * Общая подготовка тестов Mini App.
 *
 * RTL монтирует компоненты в общий document — без размонтирования соседний
 * тест находил бы кнопки предыдущего и падал на «нашлось два элемента».
 */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())
