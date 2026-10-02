const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the exact inline implementation, keeping the distributable HTML self-contained.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const { FlickEditor, createSuggestionController, getKeyboardConfig, parseSuggestions,
    withKatakana, smallMap, dakutenMap, handakutenMap } = vm.runInNewContext(
    script + '\n({ FlickEditor, createSuggestionController, getKeyboardConfig, parseSuggestions, withKatakana, smallMap, dakutenMap, handakutenMap })',
    { Intl, AbortController, setTimeout, clearTimeout, document: { addEventListener() {} } }
);
function editorAt(text, position = text.length, end = position) {
    const editor = new FlickEditor();
    editor.setText(text, position, end);
    return editor;
}

test('inserts and converts a reading between existing text without losing either side', () => {
    const editor = editorAt('今日はです。', 3);
    editor.insert('が');
    editor.insert('っ');
    editor.insert('こ');
    editor.insert('う');
    assert.equal(editor.text, '今日はがっこうです。');
    assert.equal(editor.reading, 'がっこう');
    assert.equal(editor.convertPrefix('がっこう', 'がっこう', '学校'), true);
    assert.equal(editor.text, '今日は学校です。');
    assert.equal(editor.start, 5);
    assert.equal(editor.reading, '');
});
test('replaces a selected range rather than appending', () => {
    const editor = editorAt('あいうえお', 1, 4);
    editor.insert('か');
    assert.equal(editor.text, 'あかお');
    assert.equal(editor.start, 2);
    assert.equal(editor.reading, 'か');
});
test('backspace deletes the character before the caret or the selected text', () => {
    const editor = editorAt('あいうえお', 2);
    editor.deleteBackward();
    assert.equal(editor.text, 'あうえお');
    editor.setSelection(1, 3);
    editor.deleteBackward();
    assert.equal(editor.text, 'あお');
    editor.setSelection(0);
    editor.deleteBackward();
    assert.equal(editor.text, 'あお');
});
test('cursor movement and deletion treat emoji and combining marks as one character', () => {
    for (const character of ['😀', '👨‍👩‍👧‍👦', 'か\u3099']) {
        const editor = editorAt('あ' + character + 'い', 1 + character.length);
        editor.moveCursor(-1);
        assert.equal(editor.start, 1);
        editor.moveCursor(1);
        assert.equal(editor.start, 1 + character.length);
        editor.deleteBackward();
        assert.equal(editor.text, 'あい');
    }
});
test('moving outside a reading commits it and starts a new conversion at the new position', () => {
    const editor = editorAt('前後', 1);
    editor.insert('か');
    editor.setSelection(0);
    assert.equal(editor.reading, '');
    editor.insert('あ');
    assert.equal(editor.text, 'あ前か後');
    assert.equal(editor.reading, 'あ');
});
test('edits inside a reading and deletes its last character without losing the surroundings', () => {
    const editor = editorAt('前後', 1);
    editor.insert('かこう');
    editor.setSelection(2);
    editor.modify(dakutenMap);
    assert.equal(editor.reading, 'がこう');
    editor.setSelection(2, 4);
    editor.deleteBackward();
    assert.equal(editor.reading, 'が');
    editor.deleteBackward();
    assert.equal(editor.text, '前後');
    assert.equal(editor.reading, '');
});
test('modifiers target the caret or a single selected character, including committed text', () => {
    const editor = editorAt('かはつ', 1);
    editor.modify(dakutenMap);
    assert.equal(editor.text, 'がはつ');
    assert.equal(editor.reading, 'が');
    editor.setSelection(1, 2);
    editor.modify(handakutenMap);
    assert.equal(editor.text, 'がぱつ');
    editor.setSelection(3);
    editor.modify(smallMap, 'っ');
    assert.equal(editor.text, 'がぱっ');
    editor.modify(smallMap, 'っ');
    assert.equal(editor.text, 'がぱつ');
});
test('katakana modifiers and small-character fallback keep their existing functionality', () => {
    const editor = editorAt('ウハツ');
    editor.modify(withKatakana(smallMap), 'ッ');
    assert.equal(editor.text, 'ウハッ');
    editor.setSelection(1);
    editor.modify(withKatakana(dakutenMap));
    assert.equal(editor.text, 'ヴハッ');
    editor.setSelection(2);
    editor.modify(withKatakana(handakutenMap));
    assert.equal(editor.text, 'ヴパッ');
    editor.setSelection(0);
    editor.modify(withKatakana(smallMap), 'ッ');
    assert.equal(editor.text, 'ッヴパッ');
});
test('a multi-character selection is not accidentally interpreted as a modifier map property', () => {
    const editor = editorAt('constructor', 0, 11);
    editor.modify(dakutenMap);
    assert.equal(editor.text, 'constructor');
});
test('punctuation and spaces insert at the caret and commit the reading', () => {
    const editor = editorAt('前後', 1);
    editor.insert('か');
    editor.insert('、', false);
    assert.equal(editor.text, '前か、後');
    assert.equal(editor.reading, '');
    editor.insert('　', false);
    assert.equal(editor.text, '前か、　後');
});
test('multi-segment conversion preserves the rest of the reading and existing suffix', () => {
    const editor = editorAt('前後', 1);
    editor.insert('がっこうへいく');
    const parsed = parseSuggestions([['がっこう', ['学校', '学校']], ['へいく', ['へ行く']]], editor.reading);
    assert.equal(parsed.candidates.length, 1);
    editor.convertPrefix(editor.reading, parsed.prefix, parsed.candidates[0]);
    assert.equal(editor.text, '前学校へいく後');
    assert.equal(editor.reading, 'へいく');
    editor.convertPrefix(editor.reading, 'へいく', 'へ行く');
    assert.equal(editor.text, '前学校へ行く後');
    assert.equal(editor.reading, '');
});
test('rejects a stale conversion and malformed responses', () => {
    const editor = new FlickEditor();
    editor.insert('か');
    editor.modify(dakutenMap);
    assert.equal(editor.convertPrefix('か', 'か', '化'), false);
    assert.equal(editor.text, 'が');
    for (const data of [null, [], [['か', '化']], [['き', ['木']]]]) {
        assert.throws(() => parseSuggestions(data, 'か'));
    }
});
test('native typing/paste preserves multiline text and HTML-looking strings as literal text', () => {
    const editor = editorAt('<b>あ</b>\nい', 3);
    editor.insert('か');
    assert.equal(editor.text, '<b>かあ</b>\nい');
    editor.setText('あ\nい\nう', 2);
    editor.insert('え', false);
    assert.equal(editor.text, 'あ\nえい\nう');
});
test('legacy layout retains all original rows and direction mappings', () => {
    const { map, rows } = getKeyboardConfig('legacy');
    assert.equal(rows[0].join(''), 'あかさたな');
    assert.equal(rows[1].join(''), 'はまやらわ');
    assert.equal(map['あ'].up, 'い');
    assert.equal(map['あ'].right, 'う');
    assert.equal(map['あ'].down, 'え');
    assert.equal(map['あ'].left, 'お');
    assert.equal(map['小'].center, 'SMALL');
});
test('smartphone layout uses three columns and standard directions in both kana modes', () => {
    const hira = getKeyboardConfig('smartphone');
    assert.equal(hira.rows.every(row => row.length === 3), true);
    assert.equal(hira.rows.slice(0, 3).map(row => row.join('')).join('/'), 'あかさ/たなは/まやら');
    for (const [key, characters] of [['あ', 'あいうえお'], ['か', 'かきくけこ'], ['ら', 'らりるれろ']]) {
        assert.equal(['center', 'left', 'up', 'right', 'down'].map(dir => hira.map[key][dir]).join(''), characters);
    }
    assert.equal(hira.map['や'].up, 'ゆ');
    assert.equal(hira.map['や'].down, 'よ');
    assert.equal(hira.map['わ'].left, 'を');
    assert.equal(hira.map['わ'].up, 'ん');
    const kata = getKeyboardConfig('smartphone', true);
    assert.equal(['center', 'left', 'up', 'right', 'down'].map(dir => kata.map['ア'][dir]).join(''), 'アイウエオ');
    assert.equal(kata.map['小'].center, 'SMALL');
    assert.equal(kata.map['゛゜'].right, '゜');
});

function controlledRequests() {
    const timers = new Map();
    let nextId = 0;
    const requests = [];
    const results = [];
    const statuses = [];
    const controller = createSuggestionController({
        schedule: (callback, delay) => { timers.set(++nextId, { callback, delay }); return nextId; },
        unschedule: id => timers.delete(id),
        fetcher: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
        onResult: result => results.push(result), onStatus: status => statuses.push(status)
    });
    const run = delay => {
        const entry = [...timers].find(([, timer]) => timer.delay === delay);
        assert.ok(entry, `Missing ${delay}ms timer`);
        timers.delete(entry[0]);
        return entry[1].callback();
    };
    const reply = (index, reading, candidates = [reading]) => requests[index].resolve({
        ok: true, json: async () => [[reading, candidates]]
    });
    return { controller, timers, requests, results, statuses, run, reply };
}
test('debounces rapid input and clears old candidates before requesting the latest reading', async () => {
    const c = controlledRequests();
    c.controller.update('か');
    c.controller.update('が');
    assert.equal(c.timers.size, 1);
    const pending = c.run(180);
    assert.equal(c.requests.length, 1);
    assert.ok(c.requests[0].url.endsWith(encodeURIComponent('が')));
    c.reply(0, 'が', ['賀']);
    await pending;
    assert.equal(c.results.at(-1).candidates[0], '賀');
    assert.equal(c.statuses.at(-1), 'ready');
    assert.equal(c.timers.size, 0);
});
test('an out-of-order response cannot restore candidates for the old reading even if abort is ignored', async () => {
    const c = controlledRequests();
    c.controller.update('か');
    const old = c.run(180);
    c.controller.update('が');
    const latest = c.run(180);
    assert.equal(c.requests[0].options.signal.aborted, true);
    c.reply(1, 'が', ['賀']);
    await latest;
    c.reply(0, 'か', ['化']);
    await old;
    assert.equal(c.results.at(-1).reading, 'が');
    assert.equal(c.results.at(-1).candidates[0], '賀');
});
test('clearing the active reading invalidates a pending conversion', async () => {
        const c = controlledRequests();
        c.controller.update('か');
        const pending = c.run(180);
        c.controller.update('');
        c.reply(0, 'か', ['化']);
        await pending;
        assert.equal(c.results.at(-1), null);
        assert.equal(c.statuses.at(-1), 'idle');
        assert.equal(c.timers.size, 0);
});
test('network failure and retry report status while retaining the current reading', async () => {
    const c = controlledRequests();
    c.controller.update('が');
    const failed = c.run(180);
    c.requests[0].reject(new Error('offline'));
    await failed;
    assert.equal(c.statuses.at(-1), 'error');
    c.controller.update('が');
    const retry = c.run(180);
    c.reply(1, 'が', ['賀']);
    await retry;
    assert.equal(c.statuses.at(-1), 'ready');
});
test('a timed-out response cannot resurrect candidates later', async () => {
    const c = controlledRequests();
    c.controller.update('か');
    const pending = c.run(180);
    c.run(8000);
    assert.equal(c.statuses.at(-1), 'error');
    assert.equal(c.requests[0].options.signal.aborted, true);
    c.reply(0, 'か', ['化']);
    await pending;
    assert.equal(c.results.at(-1), null);
    assert.equal(c.statuses.at(-1), 'error');
});
test('HTTP errors and invalid JSON payloads do not become selectable candidates', async () => {
    for (const response of [{ ok: false, status: 500 }, { ok: true, json: async () => ({}) }]) {
        const c = controlledRequests();
        c.controller.update('か');
        const pending = c.run(180);
        c.requests[0].resolve(response);
        await pending;
        assert.equal(c.results.at(-1), null);
        assert.equal(c.statuses.at(-1), 'error');
    }
});
