import escapeHTML from 'lodash/escape'

export function toMyNoteItems (apiNotes, moment) {
  return apiNotes
    .map(note => {
      const timestamp = moment(note.lastchangeAt || note.createdAt).valueOf()
      return {
        id: note.id,
        text: escapeHTML(note.text || 'Untitled'),
        tags: (note.tags || []).map(tag => escapeHTML(tag)),
        timestamp,
        fromNow: moment(timestamp).fromNow(),
        time: moment(timestamp).format('llll')
      }
    })
    .sort((a, b) => b.timestamp - a.timestamp)
}

export async function loadMyNotes ({ serverURL, fetch, moment }) {
  const response = await fetch(`${serverURL}/api/notes/myNotes`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Loading my notes failed with status ${response.status}`)
  const json = await response.json()
  return toMyNoteItems(json.myNotes, moment)
}

export async function deleteMyNote ({ serverURL, fetch, id }) {
  const response = await fetch(`${serverURL}/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Deleting note failed with status ${response.status}`)
}
