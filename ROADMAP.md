# Roadmap cải tiến Strix Blog

6 ý tưởng tối ưu performance + UX cho cuối tuần. Sắp theo ratio effort/impact.

## Tổng quan

| #   | Tên                    | Loại        | Effort  | Cost/tháng          | Impact  | Risk  | Status                                                   |
| --- | ---------------------- | ----------- | ------- | ------------------- | ------- | ----- | -------------------------------------------------------- |
| 11  | Response compression   | Performance | 5 phút  | $0                  | Cao     | Thấp  | ✅ Xong 2026-05-08                                       |
| 10  | Database indexes thiếu | Performance | 30 phút | $0                  | Trung   | Thấp  | ✅ Verify 2026-05-08 — không cần làm thêm                |
| 4   | Skeleton loaders       | UX          | 1.5h    | $0                  | Trung   | Không | ✅ Xong 2026-05-08                                       |
| 9   | Fix N+1 queries        | Performance | 1-3h    | $0                  | Cao     | Trung | ✅ Audit 2026-05-08 — 1 fix nhỏ                          |
| 3   | Image optimization     | Performance | 3-4h    | $0 (giảm bandwidth) | Rất cao | Thấp  | ✅ Audit 2026-05-08 — 80% đã làm sẵn, defer phần còn lại |
| 2   | CDN cache post detail  | Performance | 1-2h\*  | $0                  | Rất cao | Trung | ✅ Xong 2026-05-08                                       |

\*#2 effort cao hơn nếu phải fix Cloudflare 522 (vì `api` đang DNS only).

**Đề xuất thứ tự làm**: #11 → #10 → #4 → #9 → #3 → #2 (dễ → khó, low risk → high risk).

---

## #11 — Response compression ✅ DONE 2026-05-08

**Done**: bật gzip ở Nginx container (reverse proxy thật, không phải Caddy như
DEPLOY.md cũ). Test `/api/posts/feed`: 1517 B → 781 B (nén 48%). JSON list lớn
hơn nén được 70-85%.

**Đã sửa**: `/opt/blog-platform-backend/nginx/api.conf` thêm block:

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_proxied any;
gzip_comp_level 6;
gzip_types
    application/json
    application/javascript
    text/css
    text/plain
    text/xml
    application/xml
    application/rss+xml
    image/svg+xml;
```

**Reload command**:

```bash
docker compose -f docker-compose.prod.yml exec nginx nginx -t  # validate
docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

**Lưu ý cho tương lai**: KHÔNG bật cả `compress()` của Hono — sẽ nén 2 lần,
corrupt response. KHÔNG dùng Brotli vì Nginx alpine không có module br built-in.

---

## #10 — Database indexes ✅ VERIFIED 2026-05-08

**Kết luận**: schema đã có đầy đủ index cần thiết. Không cần làm gì thêm.

**Đã verify bằng EXPLAIN ANALYZE trên prod** với 6 query phổ biến (comments by post,
notifications unread, feed via follows, posts list, user by username,
conversations). Tất cả đều dùng Index Scan, query time < 0.1ms.

3 index ROADMAP ban đầu nghi thiếu đều **đã có**:

- `Comment(postId, createdAt DESC)` ✅ schema line 239
- `Notification(userId, isRead, createdAt DESC)` ✅ schema line 287 (dạng composite tốt hơn)
- `Follow(followerId)` ✅ implicit via `@@id([followerId, followingId])` (cột đầu của composite PK)

**Khi nào cần review lại**: khi blog đạt 10k+ posts hoặc query log có cảnh báo
slow query > 100ms. Lúc đó có thể thêm composite `(status, publishedAt DESC)`
cho posts nếu thấy `Sort` step trở thành bottleneck.

<details>
<summary>Original plan (giữ để tham khảo)</summary>

**Vấn đề**: 3 query có thể đang full scan khi data lớn dần.

**Cách làm**: chạy `EXPLAIN ANALYZE` trên prod để xác định có thiếu index không:

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ec2-user@18.142.3.239
cd /opt/blog-platform-backend
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Trong psql:
EXPLAIN ANALYZE SELECT * FROM comments
  WHERE post_id = '<random-uuid>' AND deleted_at IS NULL
  ORDER BY created_at DESC LIMIT 20;

EXPLAIN ANALYZE SELECT * FROM notifications
  WHERE recipient_id = '<random-uuid>' AND read_at IS NULL
  ORDER BY created_at DESC LIMIT 20;

EXPLAIN ANALYZE SELECT p.* FROM posts p
  JOIN follows f ON f.followee_id = p.user_id
  WHERE f.follower_id = '<random-uuid>'
  ORDER BY p.published_at DESC LIMIT 20;
```

Nếu thấy `Seq Scan` → thiếu index. Thêm vào `prisma/schema.prisma`:

```prisma
model Comment {
  ...
  @@index([postId, createdAt(sort: Desc)])
}

model Notification {
  ...
  @@index([recipientId, createdAt(sort: Desc)])
}

model Follow {
  ...
  @@index([followerId])  // chỉ thêm nếu chưa có
}
```

Bonus partial index cho notification chưa đọc (raw SQL trong migration):

```sql
CREATE INDEX notifications_unread_idx ON notifications
  (recipient_id, created_at DESC) WHERE read_at IS NULL;
```

Tạo migration:

```bash
bunx prisma migrate dev --name add_perf_indexes
```

Apply prod:

```bash
./scripts/deploy-backend.sh --migrate
```

**Verify**: chạy lại `EXPLAIN ANALYZE` trên prod → thấy `Index Scan` thay vì `Seq Scan`. Query time giảm rõ rệt.

**Trade-off**:

- Insert/update chậm hơn ít vì phải update index — không đáng kể với blog (read-heavy).
- Tốn thêm disk — vài MB.

---

## #4 — Skeleton loaders ✅ DONE 2026-05-08

**Done**: thay tất cả `Loading…` text + inline ad-hoc skeleton bằng skeleton
component có shape giống content thật, dùng màu `bg-brand-border/40` hợp tone
cream/beige của site.

**Components đã tạo** (8 file):

- `src/components/ui/Skeleton.tsx` — base primitive
- `src/components/blog/PostCardSkeleton.tsx` — card cho list/grid view
- `src/components/blog/HeroPostSkeleton.tsx` — hero card homepage
- `src/components/blog/PostDetailSkeleton.tsx` — full post page (cover + 2 cột article/sidebar)
- `src/components/blog/SavedPostCardSkeleton.tsx` — horizontal card cho /saved
- `src/components/layout/NotificationItemSkeleton.tsx` — notification row
- `src/components/chat/ConversationItemSkeleton.tsx` — chat sidebar item
- `src/components/chat/MessageBubbleSkeleton.tsx` — 5 bubble alternate

**Route/component đã sửa** (10 chỗ):

- `home.tsx` — HeroPost + CategorySection skeleton
- `blog.$username.$slug.tsx` — PostDetailSkeleton
- `blog.$username.tsx` — replace inline skeleton bằng PostCardSkeleton
- `category.$name.tsx` — replace inline skeleton bằng PostCardSkeleton
- `search.tsx` — PostCardSkeleton khi search lần đầu
- `saved.tsx` — SavedPostCardSkeleton
- `notifications.tsx` — NotificationItemSkeleton + fix bug empty container
- `NotificationBell.tsx` — NotificationItemSkeleton
- `ConversationList.tsx` — ConversationItemSkeleton
- `MessageThread.tsx` — MessageBubbleSkeleton

**Bug đã fix trong quá trình review**:

1. `notifications.tsx`: empty `<div>` border render dưới skeleton → sửa thành
   if/else if/else.
2. `MessageThread.tsx`: `flex-1` làm skeleton stretch full height → bỏ wrapper.
3. `home.tsx`: `feedError=true` có thể hiện cả "Failed to load" và empty state
   "No posts" cùng lúc → thêm `!feedError`.

**Accessibility**: tất cả skeleton wrapper có `role="status"` + `aria-label`
phù hợp ngữ cảnh.

**Lưu ý cho lần sau**: KHÔNG đụng button labels (`Saving…`, `Posting…`,
`Following…`...) — đó là pattern UX chuẩn cho mutation pending, skeleton sẽ phá.

<details>
<summary>Original plan (giữ để tham khảo)</summary>

**Vấn đề**: route hiện hiện spinner trong lúc fetch → cảm giác "trống", user
nghĩ app chậm. Nielsen Norman Group đo: cùng latency 500ms, skeleton cho cảm
giác nhanh gấp đôi spinner.

**Cách làm**: tạo skeleton component có shape giống content thật. Thay spinner.

### Bước 1: Tạo `src/components/ui/Skeleton.tsx`

```tsx
export function Skeleton({ className = "" }: { className?: string }) {
	return <div className={`animate-pulse bg-gray-200 rounded ${className}`} />;
}
```

### Bước 2: PostCardSkeleton (cho list home)

```tsx
export function PostCardSkeleton() {
	return (
		<article className="border-b py-4">
			<Skeleton className="h-6 w-3/4 mb-2" />
			<Skeleton className="h-4 w-full mb-1" />
			<Skeleton className="h-4 w-2/3 mb-3" />
			<div className="flex items-center gap-2">
				<Skeleton className="w-8 h-8 rounded-full" />
				<Skeleton className="h-4 w-32" />
			</div>
		</article>
	);
}
```

### Bước 3: Dùng trong `home.tsx`

```tsx
{
	isLoading
		? Array.from({ length: 6 }).map((_, i) => <PostCardSkeleton key={i} />)
		: posts.map((p) => <PostCard key={p.id} post={p} />);
}
```

### Bước 4: Tương tự cho `blog.$username.$slug.tsx`

```tsx
function PostSkeleton() {
	return (
		<article className="max-w-2xl mx-auto p-4">
			<Skeleton className="h-10 w-3/4 mb-4" />
			<div className="flex items-center gap-2 mb-6">
				<Skeleton className="w-10 h-10 rounded-full" />
				<Skeleton className="h-4 w-32" />
			</div>
			<Skeleton className="aspect-video w-full mb-6" />
			<div className="space-y-3">
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-5/6" />
				<Skeleton className="h-4 w-4/6" />
			</div>
		</article>
	);
}
```

**Lưu ý quan trọng**: skeleton size phải gần đúng size content thật, tránh
layout shift (CLS). Cover dùng `aspect-video` (16:9). Title 1-2 dòng.

**Routes priority**:

1. `home.tsx` — landing, FCP quan trọng nhất
2. `blog.$username.$slug.tsx` — main content
3. `category.$name.tsx` — list view
4. `blog.$username.tsx` — profile
5. Các route còn lại sau

---

## #9 — Fix N+1 queries ✅ AUDIT 2026-05-08

**Kết luận**: codebase đã được viết tốt từ trước. Audit 9 route files (3368
dòng tổng), tìm thấy **1 bug nhỏ duy nhất** — không phải N+1 mà là missing
`include` khiến frontend không nhận được data cần.

**Fix**: [src/routes/posts.ts:481-504](src/routes/posts.ts) — `GET /api/posts/:slug`
(public post detail) đang trả post **thiếu `user` và `categories`**. Frontend
fallback sang `?.` optional chaining và URL param → ẩn được bug nhưng:

- Avatar tác giả không hiện (`post.user?.avatarUrl` = undefined)
- Hiển thị username thay vì name thật (`post.user?.name ?? username`)
- Categories không có để render

Đã thêm `include` user (id, name, username, avatarUrl) + categories trong
cùng 1 query. Prisma tự JOIN, không thêm round-trip.

**Cần deploy**: `./scripts/deploy-backend.sh` (không cần `--migrate`).
Endpoint có cache Cloudflare 60s → mất tới 60s để cache mới populate.

**Các route khác đã tốt sẵn**:

| File                                                                  | Tình trạng                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversations.ts` (500 dòng)                                         | Đã có comment "Single aggregated query replaces N individual COUNT queries" — raw SQL aggregate cho unread, single `findMany` với `include` |
| `notifications.ts` (93 dòng)                                          | `NOTIFICATION_INCLUDE` bundle actor + post + post.user trong 1 query                                                                        |
| `comments.ts` (276 dòng)                                              | Đã có comment "We bundle all replies in one query (no N+1)" — 3 parallel query (top + replies + claps map)                                  |
| `posts.ts /by-categories`                                             | Đã refactor sang window function ROW_NUMBER() — comment ghi rõ "naive shape was an N+1"                                                     |
| `posts.ts /` (admin list)                                             | `count` + `findMany` parallel với `include` user + categories                                                                               |
| `bookmarks.ts`, `follows.ts`, `users.ts`, `categories.ts`, `claps.ts` | Tất cả dùng `include` / `_count` / parallel queries đúng cách                                                                               |

**Lưu ý cho lần sau**:

- Khi thêm endpoint public mới trả model có relation, **luôn check** frontend
  type Post có `user?` / `categories?` — nếu có thì backend phải `include`,
  nếu không sẽ ẩn bug như vụ /:slug này.
- Bật query log local khi nghi ngờ: `new PrismaClient({ log: ['query'] })`
  trong `db/index.ts`. Audit code static (như tôi vừa làm) nhanh và chính xác
  hơn cho codebase đã viết kỹ này.

<details>
<summary>Original plan (giữ để tham khảo)</summary>

**Vấn đề**: list posts có thể đang fetch user/clap/comment count từng cái → 60
query thay vì 1.

**Pattern N+1 (tệ)**:

```ts
const posts = await prisma.post.findMany({ take: 20 });
for (const post of posts) {
  post.author = await prisma.user.findUnique(...);       // +20 query
  post.commentCount = await prisma.comment.count(...);    // +20 query
}
// Tổng: 1 + 40 = 41 query
```

**Fix**:

```ts
const posts = await prisma.post.findMany({
	take: 20,
	include: {
		user: { select: { name: true, username: true, avatarUrl: true } },
		_count: { select: { comments: true, claps: true } },
	},
});
// 1 query (Prisma tự JOIN)
```

### Bước 1: Bật query log dev

Edit `src/db.ts`:

```ts
const prisma = new PrismaClient({
	log: process.env.NODE_ENV === "development" ? ["query"] : [],
});
```

### Bước 2: Audit từng route

Restart dev backend, mở từng route, đếm `prisma:query`:

| Route                      | Query count chấp nhận | Hiện tại (đoán) |
| -------------------------- | --------------------- | --------------- |
| `GET /api/posts`           | 1-2                   | ?               |
| `GET /api/posts/by-slug/:` | 2-4                   | ?               |
| `GET /api/notifications`   | 1-2                   | ?               |
| `GET /api/conversations`   | 2-3                   | ?               |

> 10 query / page = N+1 → fix.

### File ưu tiên audit

1. `routes/conversations.ts` (500 dòng — nghi N+1 nặng nhất)
2. `routes/posts.ts` (717 dòng)
3. `routes/notifications.ts`
4. `routes/comments.ts`

### Lưu ý khi fix

- Response shape thay đổi (`post._count.comments` thay vì `post.commentCount`).
  Test frontend kỹ. Có thể wrap output để giữ shape cũ:

  ```ts
  return c.json(
  	posts.map((p) => ({
  		...p,
  		commentCount: p._count.comments,
  		clapCount: p._count.claps,
  	})),
  );
  ```

- Hết bật query log trước khi deploy prod (`log: []` ở prod).

---

## #3 — Image optimization ✅ AUDIT 2026-05-08 — defer phần còn lại

**Kết luận**: pipeline upload **đã có sẵn** sharp resize + WebP + lazy load

- LCP priority. Ảnh upload thực tế đã được tối ưu rất tốt. Phần còn thiếu
  duy nhất là `srcSet` multi-size, lợi ích biên cho traffic hiện tại.

**Trạng thái thực tế (khác ROADMAP gốc giả định)**:

| Phần                                                              | Đã có      |
| ----------------------------------------------------------------- | ---------- |
| Backend `sharp` pipeline ([uploads.ts](src/routes/uploads.ts))    | ✅         |
| Resize max 1200px                                                 | ✅         |
| Convert WebP, quality 80%                                         | ✅         |
| EXIF rotate                                                       | ✅         |
| GIF passthrough (không flatten animation)                         | ✅         |
| Magic byte validation + ALLOWED_TYPES                             | ✅         |
| 10MB cap input                                                    | ✅         |
| Frontend `loading="lazy"` cho card                                | ✅         |
| Frontend `loading="eager"` + `fetchPriority="high"` cho LCP image | ✅         |
| Frontend `width`/`height` + `aspect-video` (no CLS)               | ✅         |
| Multi-size srcSet (400/800/1200)                                  | ❌ Chưa có |

→ Ảnh iPhone 8MB không phải vấn đề thật — backend resize xuống ~150-300KB
trước khi lưu S3. ROADMAP gốc nhầm assumption.

**Phần còn lại đáng làm sau** (multi-size srcSet):

- Lợi ích thực: tiết kiệm ~40% bandwidth cho mobile (1200px đang dư ~37%
  pixel cho viewport iPhone 13 ở 3x DPR).
- Effort: ~4h (refactor backend pipeline tạo 3 buffer/file, schema migration
  cho `coverUrl` → URL prefix, frontend `<ResponsiveImage>` component thay
  ở 5 chỗ).
- Risk: data cũ (22 post hiện tại) chỉ có 1 URL → frontend phải fallback.

**Quay lại khi**:

- Traffic mobile > 1000 user/ngày → bandwidth saving thực sự có ý nghĩa
- Hoặc bandwidth Lightsail bắt đầu chạm ngưỡng 3TB/tháng

**Alternative đáng cân nhắc thay vì refactor full**: setup Cloudflare Image
Resizing — 30 phút, $5/tháng. URL transform on-the-fly:
`https://cdn/.../image.webp` → `https://cdn/cdn-cgi/image/width=400/...`.
Không đụng backend, không tăng storage. Vendor lock-in nhẹ.

<details>
<summary>Original plan (giữ để tham khảo)</summary>

**Vấn đề**: user upload ảnh iPhone 8MB → cover load 4s → LCP fail → SEO kém +
ngốn bandwidth Lightsail (3TB/tháng giới hạn).

| Format                   | Size  | Load @ 4G |
| ------------------------ | ----- | --------- |
| Original 4032×3024 JPEG  | 8MB   | 4 giây    |
| Optimized 1600×1200 WebP | 250KB | 0.1 giây  |

**Cách làm**: pipeline sharp resize 3 sizes + WebP, frontend dùng `<img srcset>`.

### Bước 1: Sửa `src/routes/uploads.ts`

```ts
import sharp from "sharp";

const SIZES = [400, 800, 1600];

uploadsRoutes.post("/image", authMiddleware, async (c) => {
	const body = await c.req.parseBody();
	const file = body.image as File;
	if (!file) return c.json({ error: "No file" }, 400);

	const buffer = Buffer.from(await file.arrayBuffer());

	// Validate magic bytes via sharp metadata. Throws on non-image.
	let meta;
	try {
		meta = await sharp(buffer).metadata();
	} catch {
		return c.json({ error: "Invalid image" }, 400);
	}

	// Pixel bomb prevention: max 50M pixels (~7000x7000).
	if ((meta.width ?? 0) * (meta.height ?? 0) > 50_000_000) {
		return c.json({ error: "Image too large" }, 413);
	}

	const uuid = crypto.randomUUID();
	const base = sharp(buffer).rotate(); // respect EXIF orientation

	// Upload 3 variants in parallel.
	await Promise.all(
		SIZES.map(async (w) => {
			const out = await base
				.clone()
				.resize(w, null, { withoutEnlargement: true })
				.webp({ quality: w === 1600 ? 82 : 80 })
				.toBuffer();
			const key = `images/${uuid}-${w}w.webp`;
			await s3.send(
				new PutObjectCommand({
					Bucket: env.S3_BUCKET,
					Key: key,
					Body: out,
					ContentType: "image/webp",
					CacheControl: "public, max-age=31536000, immutable",
				}),
			);
		}),
	);

	const baseUrl = `${env.CDN_PUBLIC_URL ?? env.S3_PUBLIC_URL}/images/${uuid}`;
	return c.json({
		baseUrl,
		sizes: SIZES,
		// Backward compat with existing UI: trả 1 URL default 800w
		url: `${baseUrl}-800w.webp`,
	});
});
```

### Bước 2: Frontend dùng `<img srcset>`

Tạo component `<ResponsiveImage>` trong `src/components/ui/`:

```tsx
export function ResponsiveImage({
	baseUrl,
	alt,
	className,
}: {
	baseUrl: string;
	alt: string;
	className?: string;
}) {
	return (
		<img
			src={`${baseUrl}-800w.webp`}
			srcSet={`
        ${baseUrl}-400w.webp 400w,
        ${baseUrl}-800w.webp 800w,
        ${baseUrl}-1600w.webp 1600w
      `}
			sizes="(max-width: 600px) 400px, (max-width: 1200px) 800px, 1600px"
			alt={alt}
			loading="lazy"
			className={className}
		/>
	);
}
```

Replace `<img src={post.coverUrl}>` thành `<ResponsiveImage baseUrl={post.coverBaseUrl} alt={post.title} />`.

### Edge cases cần handle

- **GIF animated**: detect `meta.pages > 1` → skip resize, upload nguyên.
- **HEIC từ iPhone**: test trước; nếu sharp build không có libheif → return 415,
  yêu cầu user convert.
- **Schema migration**: post.coverUrl hiện là 1 URL, đổi thành coverBaseUrl
  (không có suffix `-XXXw.webp`). Lazy migration: ảnh cũ vẫn render bằng 1 URL,
  ảnh mới dùng srcset.

**Verify**: upload 1 ảnh → check S3 bucket có 3 file `-400w.webp`, `-800w.webp`, `-1600w.webp`. PageSpeed Insights LCP < 1s.

---

## #2 — CDN cache post detail ✅ DONE 2026-05-08

**Done**: tạo Cloudflare Cache Rule "Cache public posts API" trên Cloudflare
Dashboard. Match GET requests vào 5 path public, eligible for cache, dùng
origin Cache-Control header. Bật "Serve stale content while revalidating".

**5 endpoint đã cache** (verified `cf-cache-status: HIT` lần 2):

| Endpoint | s-maxage | Note |
| --- | --- | --- |
| `/api/posts/feed` | 30s | New post xuất hiện chậm 30s |
| `/api/posts/most-viewed` | 120s | View rank chậm 2 phút |
| `/api/posts/by-categories` | 60s | |
| `/api/posts/:slug` | 60s | View count tăng chậm (chỉ count khi cache miss) |
| `/api/categories` | 300s | |

**Cloudflare expression**:

```
(http.host eq "api.strix-blog.uk" and http.request.method eq "GET" and (
  starts_with(http.request.uri.path, "/api/posts/feed") or
  starts_with(http.request.uri.path, "/api/posts/most-viewed") or
  starts_with(http.request.uri.path, "/api/posts/by-categories") or
  starts_with(http.request.uri.path, "/api/categories") or
  (starts_with(http.request.uri.path, "/api/posts/") and
   not starts_with(http.request.uri.path, "/api/posts/id/") and
   not starts_with(http.request.uri.path, "/api/posts/public/") and
   not starts_with(http.request.uri.path, "/api/posts/search") and
   not starts_with(http.request.uri.path, "/api/posts/bulk-delete"))
))
```

**Đo lợi ích thực**:

- Latency từ máy local (VN → Singapore): 197ms → 160ms (giảm ~20%)
- Latency dự kiến từ user xa (US/EU): ~300ms → ~80ms (giảm ~70%)
- **Backend Lightsail giảm tải ~88%** với traffic 1000 user/giờ qua 1 edge:
  trước = 1000 query Postgres, sau = ~120 query (1 mỗi 30s per edge location)

**Trade-off chấp nhận**:

- Bài mới publish chậm 30-60s mới xuất hiện trên feed/category
- View count tăng chậm hơn (chỉ count khi cache miss, ~1 mỗi 30s per edge)

**Khi nào cần purge cache**:

- Sau publish bài quan trọng cần xuất hiện ngay → Cloudflare Dashboard →
  Caching → Configuration → Purge cache → Custom purge → paste URL
- Hoặc setup webhook tự động sau publish (advanced, không gấp)

**Verify command** (dùng GET, không phải HEAD):

```bash
curl -s -D - 'https://api.strix-blog.uk/api/posts/feed?limit=6' -o /dev/null | grep -i cf-cache-status
sleep 2
curl -s -D - 'https://api.strix-blog.uk/api/posts/feed?limit=6' -o /dev/null | grep -i cf-cache-status
# expected: MISS, then HIT
```

⚠️ `curl -I` (HEAD) sẽ luôn trả `DYNAMIC` vì rule chỉ match GET. Dùng `-D -` thay thế.

<details>
<summary>Original plan (giữ để tham khảo)</summary>

## #2 — CDN cache post detail (1-2h chính + debug)

**Vấn đề**: mỗi user đọc 1 bài blog → backend compute lại response giống hệt.
1 bài viral = 1000 request/phút → Lightsail 1GB RAM ho.

**Cách làm**:

```
Cache miss flow:
  User → Cloudflare → Lightsail → Postgres → response (Cloudflare lưu 5 phút)

Cache hit flow (subsequent):
  User → Cloudflare cache → response (Lightsail không biết)

Stale-while-revalidate:
  Sau 5 phút → user vẫn nhận cache cũ instant
  Cloudflare gọi backend ngầm → refresh cache
  User tiếp theo nhận response mới
```

→ Lightsail chỉ xử lý 1 request mỗi 5 phút thay vì 1000.

### Vướng: `api` đang Cloudflare DNS only

Setup hiện tại (xem `scripts/DEPLOY.md`): `api.strix-blog.uk` không qua Cloudflare proxy → cache rule không có tác dụng.

2 lựa chọn:

- **Cách A**: bật proxy Cloudflare (orange cloud) → có thể quay lại 522 error.
  Setup Cloudflare Tunnel để stable. Effort: 1h.
- **Cách B**: cache ở Caddy (Lightsail) bằng plugin `cache-handler` hoặc
  `souin`. Vẫn giảm load Postgres, không có edge global. Effort: 2h.

### Backend changes

#### Bước 1: Tách endpoint cá nhân hoá

Vấn đề tinh tế: nếu response có `hasUserClapped: true` → cá nhân hoá → không cache được.

Tách:

| Endpoint                                | Cache         | Trả                                |
| --------------------------------------- | ------------- | ---------------------------------- |
| `GET /api/posts/by-slug/:user/:slug`    | 5 phút public | Nội dung, tác giả, count           |
| `GET /api/posts/by-slug/:user/:slug/me` | No cache      | `{ clapped, bookmarked }` của user |

#### Bước 2: Cache header

```ts
postsRoutes.get("/by-slug/:username/:slug", async (c) => {
	const post = await prisma.post.findFirst({
		where: { /* ... */ status: "published", deletedAt: null },
	});
	if (!post) return c.json({ error: "Not found" }, 404);

	c.header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
	return c.json(post);
});

// Endpoint cá nhân hoá riêng
postsRoutes.get("/by-slug/:username/:slug/me", authMiddleware, async (c) => {
	const user = c.get("user");
	const post = await prisma.post.findFirst({
		where: {
			/* ... */
		},
		select: { id: true },
	});
	if (!post) return c.json({ error: "Not found" }, 404);

	const [clap, bookmark] = await Promise.all([
		prisma.postClap.findUnique({
			where: { userId_postId: { userId: user.sub, postId: post.id } },
		}),
		prisma.postBookmark.findUnique({
			where: { userId_postId: { userId: user.sub, postId: post.id } },
		}),
	]);

	c.header("Cache-Control", "no-store");
	return c.json({
		clapped: !!clap && clap.count > 0,
		clapCount: clap?.count ?? 0,
		bookmarked: !!bookmark,
	});
});
```

#### Bước 3: Frontend gọi 2 endpoint song song

```tsx
const { data: post } = useQuery({
	queryKey: ["post", username, slug],
	queryFn: () => fetchPost(username, slug),
});

const { data: me } = useQuery({
	queryKey: ["post-me", username, slug],
	queryFn: () => fetchPostMe(username, slug),
	enabled: !!user, // chỉ fetch khi đã login
});
```

#### Bước 4: Cloudflare Cache Rule (nếu chọn cách A)

Cloudflare Dashboard → Caching → Cache Rules → Create:

- Name: `Cache post detail API`
- If: `(http.request.uri.path matches "^/api/posts/by-slug/[^/]+/[^/]+$")`
- Then: **Eligible for cache** + **Use origin cache control**

**Verify**: `curl -I https://api.strix-blog.uk/api/posts/by-slug/<user>/<slug>` 2 lần. Lần 2 phải có `cf-cache-status: HIT`.

### Trade-off

| Lợi                             | Hại                                            |
| ------------------------------- | ---------------------------------------------- |
| Backend giảm 90% load           | Data cũ tối đa 5 phút                          |
| Response < 50ms toàn cầu (edge) | Edit bài rồi không thấy đổi liền               |
| Chống viral kill server         | Thêm complexity (2 endpoint, 2 query frontend) |

---

## Pre-flight checklist trước khi bắt tay

- [ ] Pull code mới về máy nhà (rsync/scp).
- [ ] `cd blog-platform-backend && bun install` — đồng bộ deps.
- [ ] `bunx prisma generate` — regen client.
- [ ] Backup prod DB nếu sprint có migration:

  ```bash
  mkdir -p backups
  ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ec2-user@18.142.3.239 \
    "cd /opt/blog-platform-backend && source .env && \
     docker compose -f docker-compose.prod.yml exec -T postgres \
     pg_dump -U \$POSTGRES_USER \$POSTGRES_DB" \
    | gzip > backups/prod_$(date +%Y%m%d_%H%M%S).sql.gz
  ```

- [ ] Check key SSH ở máy nhà: `~/.ssh/LightsailDefaultKey-ap-southeast-1.pem` (chmod 400).
- [ ] AWS CLI configured (cho deploy frontend SPA): `aws configure`.

## Deploy reference

- Backend: `./scripts/deploy-backend.sh` (thêm `--migrate` nếu có Prisma migration mới)
- Frontend: `./scripts/deploy-frontend.sh`
- Admin: `./scripts/deploy-admin.sh`

Prod IP: `18.142.3.239` — Lightsail Singapore.
Domain: `https://strix-blog.uk` (frontend), `https://admin.strix-blog.uk` (admin), `https://api.strix-blog.uk` (backend).

## Notes

- Stack: Bun + Hono + Prisma 7 + Postgres + Redis. BullMQ đã gỡ, ioredis còn dùng cho rate limit + view counter + WS.
- Frontend: React 19 + TanStack Router + TanStack Query + TipTap + Tailwind v4 + Zustand.
- Đã gỡ AI/RAG/embedding stack ngày 2026-05-08. Git history còn nguyên nếu cần revert.
- AWS S3 access key đã rotate ngày 2026-05-08.
- Backup pre-deploy AI removal: `backups/prod_predeploy_20260508_141957.sql.gz`.
