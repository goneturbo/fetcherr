import test from 'node:test'
import assert from 'node:assert/strict'
import { rankSearchResults } from '../src/search-rank.js'

const label = (items: Array<Record<string, unknown>>) => items.map(item => `${item.Type}:${item.Name}`)

test('an exact title match comes first, whatever its type', () => {
  const items = [
    { Name: 'Rasputin: The Mad Monk', Type: 'Movie' },
    { Name: 'Bulletproof Monk', Type: 'Movie' },
    { Name: 'Monk', Type: 'Movie' },
    { Name: 'Monkey Man', Type: 'Movie' },
    { Name: 'Monk Comes Down the Mountain', Type: 'Movie' },
    { Name: 'Monk', Type: 'Series' },
    { Name: 'The Monk', Type: 'Movie' },
    { Name: 'Monk Webisodes', Type: 'Series' },
  ]
  assert.deepEqual(label(rankSearchResults(items, 'Monk')), [
    'Movie:Monk', 'Series:Monk', 'Movie:The Monk',
    'Movie:Monk Comes Down the Mountain', 'Series:Monk Webisodes',
    'Movie:Rasputin: The Mad Monk', 'Movie:Bulletproof Monk',
    'Movie:Monkey Man',
  ])
})

test('case, accents, punctuation and a leading article do not stop a match', () => {
  const items = [{ Name: 'Something Else', Type: 'Movie' }, { Name: 'Amélie', Type: 'Movie' }, { Name: 'The Jetsons', Type: 'Series' }]
  assert.deepEqual(label(rankSearchResults(items, 'amelie')), ['Movie:Amélie', 'Movie:Something Else', 'Series:The Jetsons'])
  assert.deepEqual(label(rankSearchResults(items, 'JETSONS')), ['Series:The Jetsons', 'Movie:Something Else', 'Movie:Amélie'])
})

test('a Thai original title holding one Latin word is not a false exact match', () => {
  const items = [
    { Name: 'Will You Marry Monk?', OriginalTitle: 'แต่ง…Monk', Type: 'Movie' },
    { Name: 'Monk', Type: 'Movie' },
  ]
  assert.deepEqual(label(rankSearchResults(items, 'monk')), ['Movie:Monk', 'Movie:Will You Marry Monk?'])
})

test('a Romanian cedilla title and its comma-below spelling match each other', () => {
  const cedilla = [{ Name: 'Moromeţii', Type: 'Movie' }]
  const commaBelow = [{ Name: 'Moromeții', Type: 'Movie' }]
  assert.deepEqual(label(rankSearchResults(cedilla, 'Moromeții')), ['Movie:Moromeţii'])
  assert.deepEqual(label(rankSearchResults(commaBelow, 'Moromeţii')), ['Movie:Moromeții'])
})

test('a term that matches no title as a word leaves the order alone, and nothing is modified', () => {
  const items = [{ Name: 'Monkey Man', Type: 'Movie' }, { Name: 'Monk', Type: 'Series' }]
  const before = JSON.stringify(items)
  assert.deepEqual(label(rankSearchResults(items, 'Monk 2002')), ['Movie:Monkey Man', 'Series:Monk'])
  assert.deepEqual(label(rankSearchResults(items, '')), ['Movie:Monkey Man', 'Series:Monk'])
  assert.equal(JSON.stringify(items), before)
})

test('items without a name sort last and do not throw', () => {
  const items = [{ Type: 'Movie' }, { Name: 'Monk', Type: 'Series' }]
  assert.deepEqual(rankSearchResults(items, 'monk').map(item => item.Type), ['Series', 'Movie'])
})

test('a title ranks by the better of its name and its original title', () => {
  const items = [
    { Name: 'Call My Agent! The Movie', OriginalTitle: 'Dix Pour Cent ! Le Film', Type: 'Movie' },
    { Name: 'Call My Agent!', OriginalTitle: 'Dix pour cent', Type: 'Series' },
    { Name: 'Dix pour cent', OriginalTitle: 'Ten Percent', Type: 'Movie' },
  ]
  assert.deepEqual(label(rankSearchResults(items, 'Dix pour cent')), [
    'Series:Call My Agent!', 'Movie:Dix pour cent', 'Movie:Call My Agent! The Movie',
  ])
})
