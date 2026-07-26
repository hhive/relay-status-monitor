import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

test('account list owns an independent paginated request with complete query state', () => {
  const shared = source('src/components/account-observability/account-overview.tsx');

  assert.match(shared, /useState<AccountListResponseDto \| null>\(null\)/);
  assert.match(shared, /useState<AccountPageSize>\(50\)/);
  assert.match(shared, /useState\(1\)/);
  assert.match(shared, /const \[sortReady, setSortReady\] = useState\(false\)/);
  assert.match(shared, /const overviewSequence = useRef\(0\)/);
  assert.match(shared, /const listSequence = useRef\(0\)/);
  assert.match(shared, /if \(!sortReady\) return/);
  assert.match(shared, /\/api\/accounts\/list\?\$\{params(?:\.toString\(\))?\}/);
  for (const key of ['window', 'status', 'sortKey', 'sortOrder', 'page', 'pageSize']) {
    assert.match(shared, new RegExp(`${key}(?:\\s*:|\\s*,)`), `list request must include ${key}`);
  }
  for (const key of ['platform', 'group', 'search']) {
    assert.match(shared, new RegExp(`params\\.set\\('${key}'`), `list request must include optional ${key}`);
  }
  assert.match(shared, /setPage\(body\.pagination\.page\)/);
  assert.match(shared, /listOnly[\s\S]*?fetchList/);
  assert.match(shared, /if \(listOnly\) return/);
});

test('account list resets page for query changes and debounces search', () => {
  const shared = source('src/components/account-observability/account-overview.tsx');

  assert.match(shared, /window\.setTimeout\([\s\S]*?250\)/);
  assert.match(shared, /setDeferredSearch\(search\.trim\(\)\);[\s\S]*?setPage\(1\)/);
  for (const handler of ['changeWindow', 'changeStatus', 'changePlatform', 'changeGroup', 'updateSort']) {
    assert.match(shared, new RegExp(`const ${handler} =[\\s\\S]*?setPage\\(1\\)`), `${handler} must reset the page`);
  }
  assert.match(shared, /setPageSize\(Number\(value\) as AccountPageSize\);[\s\S]*?setPage\(1\)/);
});

test('pagination renders server rows, page sizes, ranges and accessible boundaries', () => {
  const shared = source('src/components/account-observability/account-overview.tsx');

  assert.match(shared, /getPaginationItems\(page, totalPages\)/);
  assert.match(shared, /totalItems === 0 \? 0/);
  assert.match(shared, /ACCOUNT_PAGE_SIZES\.map/);
  assert.match(shared, /aria-label="每页账号数"/);
  assert.match(shared, /PaginationPrevious/);
  assert.match(shared, /PaginationNext/);
  assert.match(shared, /PaginationEllipsis/);
  assert.match(shared, /aria-disabled=\{page <= 1\}/);
  assert.match(shared, /tabIndex=\{page <= 1 \? -1 : 0\}/);
  assert.match(shared, /aria-disabled=\{page >= totalPages\}/);
  assert.match(shared, /tabIndex=\{page >= totalPages \? -1 : 0\}/);
  assert.match(shared, /event\.preventDefault\(\)/);
  assert.match(shared, /accounts=\{list\.accounts\}/);
  assert.doesNotMatch(shared, /sortAccountSummaries/);
  assert.doesNotMatch(shared, /max-h-\[34rem\]/);
  assert.match(shared, /overflow-x-auto rounded-md border/);
});

test('overview and list failures are isolated and alert events remain unpaginated', () => {
  const shared = source('src/components/account-observability/account-overview.tsx');
  const eventsPage = source('src/app/(dashboard)/incidents/page.tsx');
  const eventsApi = source('src/app/api/account-alert-events/route.ts');

  assert.match(shared, /setOverviewError/);
  assert.match(shared, /setListError/);
  assert.match(shared, /setList\(\(prev\)/);
  assert.match(shared, /result === 'saved'[\s\S]*?fetchList\(\)/);
  assert.match(shared, /list(?:\?|)\.facets\.platforms/);
  assert.match(shared, /window=\{(?:list|data)\.window\}/);
  assert.doesNotMatch(eventsPage, /pageSize|pagination|setPage/);
  assert.doesNotMatch(eventsApi, /pageSize|pagination|\bpage\b/);
});
