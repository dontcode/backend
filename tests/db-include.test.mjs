import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { dontcode, isDontCodeError } from '../dist/index.js'
import { startMockServer } from '../dist/mock/index.js'

/**
 * include on the mock gateway, which runs the gateway's executor against real
 * Postgres (PGlite): the SQL that ranks related rows per parent, the catalog
 * read that finds the foreign keys, and the stitching all run for real.
 */

let mock
let client

before(async () => {
    mock = await startMockServer({ dataDir: null, quiet: true, port: 0 })
    client = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
    await client.db.migrate({
        sql: `
            CREATE TABLE writers (id serial primary key, name text);
            CREATE TABLE articles (id serial primary key, title text, writer_id int references writers(id));
            CREATE TABLE remarks (
                id serial primary key,
                article_id int references articles(id),
                writer_id int references writers(id),
                body text,
                hidden boolean default false,
                posted int
            );
            INSERT INTO writers (name) VALUES ('Ji'), ('Min');
            INSERT INTO articles (title, writer_id) VALUES ('A', 1), ('B', null), ('C', 2);
            INSERT INTO remarks (article_id, writer_id, body, hidden, posted) VALUES
                (1, 2, 'first', false, 1), (1, 1, 'second', false, 2),
                (1, 1, 'hidden', true, 3), (1, 2, 'third', false, 4), (3, 1, 'on C', false, 1);
        `,
    })
})

after(async () => {
    await mock.close()
})

describe('mock gateway: include', () => {
    it('brings the referenced row, and the rows pointing back ranked per parent', async () => {
        const articles = await client.db.articles.find({
            orderBy: { id: 'asc' },
            include: {
                writer: true,
                remarks: { where: { hidden: false }, orderBy: { posted: 'desc' }, limit: 2 },
            },
        })

        assert.deepEqual(
            articles.map((a) => ({
                title: a.title,
                writer: a.writer?.name ?? null,
                remarks: a.remarks.map((r) => r.body),
            })),
            [
                { title: 'A', writer: 'Ji', remarks: ['third', 'second'] },
                { title: 'B', writer: null, remarks: [] },
                { title: 'C', writer: 'Min', remarks: ['on C'] },
            ]
        )
    })

    it('nests, keeps a narrow select narrow, and works on findFirst', async () => {
        const article = await client.db.articles.findFirst({
            where: { id: 1 },
            select: ['id', 'title'],
            include: {
                remarks: { limit: 1, orderBy: { posted: 'asc' }, include: { writer: true } },
            },
        })

        assert.deepEqual(Object.keys(article).sort(), ['id', 'remarks', 'title'])
        assert.equal(article.remarks[0].body, 'first')
        assert.equal(article.remarks[0].writer.name, 'Min')
    })

    it('goes the other way: a writer with their articles', async () => {
        const writer = await client.db.writers.findOne({
            where: { name: 'Min' },
            include: { articles: true },
        })

        assert.deepEqual(
            writer.articles.map((a) => a.title),
            ['C']
        )
    })

    it('says which include it cannot resolve', async () => {
        await assert.rejects(
            () => client.db.articles.find({ include: { likes: true } }),
            (err) =>
                isDontCodeError(err) &&
                err.status === 400 &&
                /Cannot resolve include "likes"/.test(err.message)
        )
    })
})
