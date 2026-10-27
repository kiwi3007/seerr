import type { ReadarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chaptarrNativeBaseUrl,
  normalizeIdentity,
  resolveHardcoverBookId,
  type ChaptarrNativeBook,
  type ChaptarrNativeEdition,
  type ChaptarrSource,
  type HardcoverIdentityLookup,
} from './hardcoverResolver';

const server = (baseUrl?: string) => ({ baseUrl }) as ReadarrSettings;

function chaptarr(
  book: Partial<ChaptarrNativeBook>,
  editions: ChaptarrNativeEdition[],
  authorName?: string
): ChaptarrSource {
  return {
    getBook: async (id) => ({ id, title: 'Untitled', authorId: 7, ...book }),
    getEditions: async () => editions,
    getAuthorName: async () => authorName,
  };
}

function hardcover(answers: {
  editions?: number[];
  identifiers?: number[];
  search?: { id: number; title: string; authorNames: string[] }[];
}) {
  const calls: string[] = [];
  const lookup: HardcoverIdentityLookup = {
    getBookIdsForEditions: async (ids) => {
      calls.push(`editions:${ids.join(',')}`);
      return answers.editions ?? [];
    },
    getBookIdsForIdentifiers: async ({ isbn13s, asins }) => {
      calls.push(`identifiers:${[...isbn13s, ...asins].join(',')}`);
      return answers.identifiers ?? [];
    },
    searchBookIdentities: async (query) => {
      calls.push(`search:${query}`);
      return answers.search ?? [];
    },
  };
  return { lookup, calls };
}

describe('chaptarrNativeBaseUrl', () => {
  it('strips the Hardcover facade path', () => {
    assert.equal(chaptarrNativeBaseUrl(server('/readarr/hc/audiobook')), '');
    assert.equal(
      chaptarrNativeBaseUrl(server('/chaptarr/readarr/hc/ebook/')),
      '/chaptarr'
    );
  });

  it('ignores plain Readarr and non-Hardcover facades', () => {
    assert.equal(chaptarrNativeBaseUrl(server('')), null);
    assert.equal(chaptarrNativeBaseUrl(server(undefined)), null);
    assert.equal(chaptarrNativeBaseUrl(server('/readarr/gr/ebook')), null);
  });
});

describe('normalizeIdentity', () => {
  it('drops edition noise, articles, accents and punctuation', () => {
    assert.equal(
      normalizeIdentity('Dawnshard [Dramatized Adaptation]'),
      'dawnshard'
    );
    assert.equal(
      normalizeIdentity('Beyond the Shadows (Dramatized Adaptation)'),
      'beyond the shadows'
    );
    assert.equal(normalizeIdentity('The Eleventh Metal'), 'eleventh metal');
    assert.equal(
      normalizeIdentity('Alcatraz Versus The Scrivener’s Bones'),
      'alcatraz versus the scriveners bones'
    );
  });
});

describe('resolveHardcoverBookId', () => {
  it('prefers a Hardcover edition ID and stops there', async () => {
    const hc = hardcover({ editions: [374131], identifiers: [999] });
    const result = await resolveHardcoverBookId(
      12,
      chaptarr({ title: 'Words of Radiance' }, [
        { hardcoverEditionId: '30692548', isbn13: '9781628512946' },
      ]),
      hc.lookup
    );

    assert.deepEqual(result, { hcId: 374131, method: 'edition' });
    assert.deepEqual(hc.calls, ['editions:30692548']);
  });

  it('falls back to ISBN-13s and ASINs when editions are inconclusive', async () => {
    const hc = hardcover({ editions: [1, 2], identifiers: [446680] });
    const result = await resolveHardcoverBookId(
      12,
      chaptarr({ title: "Carl's Doomsday Scenario", asin: 'B09345T1HY' }, [
        {
          hardcoverEditionId: '5',
          isbn13: '9798228815988',
          asins: ['B09345T1HY'],
        },
        { hardcoverEditionId: '6' },
      ]),
      hc.lookup
    );

    assert.deepEqual(result, { hcId: 446680, method: 'identifier' });
    assert.deepEqual(hc.calls, [
      'editions:5,6',
      'identifiers:9798228815988,B09345T1HY',
    ]);
  });

  it('gives up without searching when identifiers point at several books', async () => {
    const hc = hardcover({ identifiers: [676415, 429355] });
    const result = await resolveHardcoverBookId(
      12,
      chaptarr(
        { title: 'White Sand' },
        [{ isbn13: '9781645415145' }],
        'Brandon Sanderson'
      ),
      hc.lookup
    );

    assert.equal(result, null);
    assert.ok(!hc.calls.some((c) => c.startsWith('search:')));
  });

  it('accepts a single exact title + author match, ignoring decoys', async () => {
    const hc = hardcover({
      search: [
        {
          id: 1,
          title: 'Study Guide: The Eleventh Metal',
          authorNames: ['SuperSummary'],
        },
        {
          id: 427844,
          title: 'The Eleventh Metal',
          authorNames: ['Brandon Sanderson'],
        },
        { id: 3, title: 'The Eleventh Metal', authorNames: ['Someone Else'] },
      ],
    });
    const result = await resolveHardcoverBookId(
      12,
      chaptarr({ title: 'The Eleventh Metal' }, [], 'Sanderson, Brandon'),
      hc.lookup
    );

    assert.deepEqual(result, { hcId: 427844, method: 'title' });
    assert.deepEqual(hc.calls, ['search:The Eleventh Metal brandon sanderson']);
  });

  it('refuses ambiguous or author-less title matches', async () => {
    const twoMatches = hardcover({
      search: [
        {
          id: 2014201,
          title: 'What Seems To Be The Problem',
          authorNames: ['Adam Kay'],
        },
        {
          id: 1248009,
          title: 'What Seems to Be the Problem',
          authorNames: ['Adam Kay'],
        },
      ],
    });
    assert.equal(
      await resolveHardcoverBookId(
        12,
        chaptarr({ title: 'What Seems to Be the Problem' }, [], 'Adam Kay'),
        twoMatches.lookup
      ),
      null
    );

    const noAuthor = hardcover({
      search: [{ id: 9, title: 'Orphan', authorNames: ['Anyone'] }],
    });
    assert.equal(
      await resolveHardcoverBookId(
        12,
        chaptarr({ title: 'Orphan' }, []),
        noAuthor.lookup
      ),
      null
    );
    assert.deepEqual(noAuthor.calls, []);
  });
});
