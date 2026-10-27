import type { HardcoverBookIdentity } from '@server/api/hardcover';
import ReadarrAPI from '@server/api/servarr/readarr';
import type { ReadarrSettings } from '@server/lib/settings';

/**
 * Chaptarr exposes a Readarr-compatible facade (`/readarr/hc/<format>`) that reports each book's
 * Hardcover work ID as `foreignBookId`. When Chaptarr's own metadata never mapped a book to a
 * Hardcover work, that field is empty and the scanner can't match the book, even though
 * Chaptarr's native API often still knows a Hardcover *edition* ID, ISBN-13s or ASINs for it
 * (typical for edition-specific Goodreads entries such as GraphicAudio dramatised releases).
 *
 * This resolves those books to a Hardcover book ID, most certain first:
 *   1. Hardcover edition IDs   -> the book they belong to (exact)
 *   2. ISBN-13s / ASINs        -> the book owning an edition with that identifier (exact)
 *   3. title + author search   -> accepted only for a single exact normalised match
 * Anything ambiguous is left unresolved rather than guessed.
 *
 * Dramatised releases (GraphicAudio, full-cast) are deliberately skipped. Chaptarr keeps them as
 * separate books, but Hardcover usually files them as editions of the base work, so resolving one
 * would mark the base work's audiobook as owned and stop users requesting the narrated version.
 */

const FACADE_PATH = /\/readarr\/hc\/[^/]+\/?$/;

/** Native Chaptarr base path for a server configured on its Hardcover facade, else null. */
export const chaptarrNativeBaseUrl = (
  server: ReadarrSettings
): string | null =>
  server.baseUrl && FACADE_PATH.test(server.baseUrl)
    ? server.baseUrl.replace(FACADE_PATH, '')
    : null;

const EDITION_NOISE =
  /\s*[[(][^\])]*(dramati[sz]ed|adaptation|unabridged|abridged|graphic ?audio|full[- ]cast|audiobook|edition)[^\])]*[\])]/gi;

/** Lowercase, accent/punctuation-free title or name with edition noise and leading articles removed. */
export const normalizeIdentity = (value: string | undefined | null): string =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(EDITION_NOISE, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');

/** Readarr-style "Last, First" author names become "First Last" before normalising. */
const normalizeAuthor = (name: string | undefined | null): string => {
  const raw = name ?? '';
  const comma = raw.indexOf(',');
  return normalizeIdentity(
    comma > 0 ? `${raw.slice(comma + 1)} ${raw.slice(0, comma)}` : raw
  );
};

export interface ChaptarrNativeBook {
  id: number;
  title: string;
  authorId?: number;
  asin?: string | null;
  audibleASIN?: string | null;
}

export interface ChaptarrNativeEdition {
  hardcoverEditionId?: string | null;
  isbn13?: string | null;
  asin?: string | null;
  audibleASIN?: string | null;
  asins?: string[] | null;
}

const DRAMATISED = /dramati[sz]ed|graphic ?audio|full[- ]cast|[[({]GA[\])}]/i;

/**
 * A GraphicAudio/full-cast release, judged by the book title or the owned files' paths. Chaptarr
 * often lists narrated and GraphicAudio editions under one book, and doesn't report which edition
 * a file belongs to, but release names reliably carry "GraphicAudio", "[GA]" or "Full Cast".
 */
export const isDramatisedRelease = (
  title: string,
  filePaths: string[]
): boolean =>
  DRAMATISED.test(title) || filePaths.some((path) => DRAMATISED.test(path));

export interface ChaptarrSource {
  getBook(id: number): Promise<ChaptarrNativeBook>;
  getEditions(bookId: number): Promise<ChaptarrNativeEdition[]>;
  getBookFilePaths(bookId: number): Promise<string[]>;
  getAuthorName(authorId: number): Promise<string | undefined>;
}

export interface HardcoverIdentityLookup {
  getBookIdsForEditions(editionIds: number[]): Promise<number[]>;
  getBookIdsForIdentifiers(ids: {
    isbn13s: string[];
    asins: string[];
  }): Promise<number[]>;
  searchBookIdentities(query: string): Promise<HardcoverBookIdentity[]>;
}

export type ResolutionMethod = 'edition' | 'identifier' | 'title';

export interface Resolution {
  hcId: number;
  method: ResolutionMethod;
}

const present = (values: (string | null | undefined)[]): string[] => [
  ...new Set(
    values.map((v) => v?.trim()).filter((v): v is string => Boolean(v))
  ),
];

export const resolveHardcoverBookId = async (
  chaptarrBookId: number,
  chaptarr: ChaptarrSource,
  hardcover: HardcoverIdentityLookup
): Promise<Resolution | null> => {
  const [book, editions, filePaths] = await Promise.all([
    chaptarr.getBook(chaptarrBookId),
    chaptarr.getEditions(chaptarrBookId),
    chaptarr.getBookFilePaths(chaptarrBookId),
  ]);

  if (isDramatisedRelease(book.title, filePaths)) {
    return null;
  }

  const editionIds = [
    ...new Set(
      editions
        .map((e) => Number(e.hardcoverEditionId))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  if (editionIds.length) {
    const ids = await hardcover.getBookIdsForEditions(editionIds);
    if (ids.length === 1) {
      return { hcId: ids[0], method: 'edition' };
    }
  }

  const isbn13s = present(editions.map((e) => e.isbn13));
  const asins = present([
    book.asin,
    book.audibleASIN,
    ...editions.flatMap((e) => [e.asin, e.audibleASIN, ...(e.asins ?? [])]),
  ]);
  if (isbn13s.length || asins.length) {
    const ids = await hardcover.getBookIdsForIdentifiers({ isbn13s, asins });
    if (ids.length === 1) {
      return { hcId: ids[0], method: 'identifier' };
    }
    if (ids.length > 1) {
      // Identifiers point at several Hardcover books; a title search can't do better.
      return null;
    }
  }

  const author =
    book.authorId !== undefined
      ? normalizeAuthor(await chaptarr.getAuthorName(book.authorId))
      : '';
  if (!author) {
    return null;
  }

  const wantedTitle = normalizeIdentity(book.title);
  const hits = await hardcover.searchBookIdentities(`${book.title} ${author}`);
  const matches = hits.filter(
    (hit) =>
      normalizeIdentity(hit.title) === wantedTitle &&
      hit.authorNames.some((name) => normalizeAuthor(name) === author)
  );

  return matches.length === 1 ? { hcId: matches[0].id, method: 'title' } : null;
};

class ChaptarrNativeAPI extends ReadarrAPI {
  public getNativeBook = (id: number) =>
    this.get<ChaptarrNativeBook>(`/book/${id}`);

  public getNativeEditions = (bookId: number) =>
    this.get<ChaptarrNativeEdition[]>('/edition', { params: { bookId } });

  public getBookFilePaths = async (bookId: number) =>
    (
      await this.get<{ path?: string }[]>('/bookfile', { params: { bookId } })
    ).map((file) => file.path ?? '');

  public getAuthorName = async (authorId: number) =>
    (await this.get<{ authorName?: string }>(`/author/${authorId}`)).authorName;
}

/** Native-API source for a server on Chaptarr's Hardcover facade, else null. */
export const chaptarrSourceFor = (
  server: ReadarrSettings
): ChaptarrSource | null => {
  const nativeBase = chaptarrNativeBaseUrl(server);
  if (nativeBase === null) {
    return null;
  }

  const api = new ChaptarrNativeAPI({
    apiKey: server.apiKey,
    url: ReadarrAPI.buildUrl({ ...server, baseUrl: nativeBase }, '/api/v1'),
  });

  return {
    getBook: api.getNativeBook,
    getEditions: api.getNativeEditions,
    getBookFilePaths: api.getBookFilePaths,
    getAuthorName: api.getAuthorName,
  };
};
