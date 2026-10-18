#!/usr/bin/env python3
"""Check the isolated SQLite database after the browser import verification."""
import argparse
import json
import sqlite3

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('database', help='SQLite database used by the isolated CodiMD server')
args = parser.parse_args()
connection = sqlite3.connect('file:' + args.database + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
expected_titles = {
    '---\ntitle: 中文匯入標題\ntags: [匯入, 測試]\n---\n# H1 備用標題\n\n中文 UTF-8 正文。\n': '中文匯入標題',
    '# H1 標題\n正文\n': 'H1 標題',
    '沒有標題的正文\n': 'Untitled',
    ' \n': 'Untitled',
}
checked = []
try:
    for content, title in expected_titles.items():
        notes = connection.execute('SELECT * FROM Notes WHERE content = ?', (content,)).fetchall()
        assert notes, f'Missing imported note: {title}'
        for note in notes:
            assert note['title'] == title, f'Incorrect database title: {note["title"]}'
            expected_permission = 'editable' if note['ownerId'] else 'freely'
            assert note['permission'] == expected_permission, f'Incorrect permission for {title}'
            revisions = connection.execute('SELECT * FROM Revisions WHERE noteId = ?', (note['id'],)).fetchall()
            assert len(revisions) == 1, f'Expected one initial revision for {title}'
            revision_content = revisions[0]['content'] or revisions[0]['lastContent']
            assert revision_content == content, f'Incorrect initial revision for {title}'
            checked.append({'title': title, 'owner': bool(note['ownerId']), 'permission': note['permission'], 'revisions': len(revisions)})
    assert any(note['owner'] for note in checked), 'Missing authenticated import'
    assert any(not note['owner'] for note in checked), 'Missing anonymous import'
    print(json.dumps({'verified_notes': checked}, ensure_ascii=False, indent=2))
finally:
    connection.close()
