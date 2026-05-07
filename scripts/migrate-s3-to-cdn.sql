-- Rewrite stored image URLs from the raw S3 endpoint to the CloudFront CDN.
--
-- Run AFTER CloudFront + OAC are live and you've verified a fresh upload works
-- through the CDN. Run BEFORE you flip S3 public access off (otherwise legacy
-- URLs already serving in production will start returning 403).
--
-- Replace the two URLs below if your setup differs.
--   OLD = https://strix-blog-media.s3.ap-southeast-1.amazonaws.com
--   NEW = https://cdn.strix-blog.uk
--
-- Safety: each statement is idempotent (replace() is a no-op when the OLD
-- prefix is absent), so re-running this script after partial success is safe.

BEGIN;

-- 1) User avatars
UPDATE users
SET avatar_url = REPLACE(
    avatar_url,
    'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com',
    'https://cdn.strix-blog.uk'
)
WHERE avatar_url LIKE 'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com/%';

-- 2) Post cover + OG images
UPDATE posts
SET cover_url = REPLACE(
    cover_url,
    'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com',
    'https://cdn.strix-blog.uk'
)
WHERE cover_url LIKE 'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com/%';

UPDATE posts
SET og_image_url = REPLACE(
    og_image_url,
    'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com',
    'https://cdn.strix-blog.uk'
)
WHERE og_image_url LIKE 'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com/%';

-- 3) Inline images embedded in post HTML
UPDATE posts
SET content_html = REPLACE(
    content_html,
    'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com',
    'https://cdn.strix-blog.uk'
)
WHERE content_html LIKE '%https://strix-blog-media.s3.ap-southeast-1.amazonaws.com%';

-- 4) Chat message attachments
UPDATE chat_messages
SET image_url = REPLACE(
    image_url,
    'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com',
    'https://cdn.strix-blog.uk'
)
WHERE image_url LIKE 'https://strix-blog-media.s3.ap-southeast-1.amazonaws.com/%';

-- Sanity check: should all be 0 after migration. If not, inspect the rows
-- and decide whether they're legacy/external URLs that deliberately stay.
SELECT 'users.avatar_url'    AS col, COUNT(*) AS remaining FROM users         WHERE avatar_url   LIKE 'https://strix-blog-media.s3.%'
UNION ALL
SELECT 'posts.cover_url',          COUNT(*)              FROM posts         WHERE cover_url    LIKE 'https://strix-blog-media.s3.%'
UNION ALL
SELECT 'posts.og_image_url',       COUNT(*)              FROM posts         WHERE og_image_url LIKE 'https://strix-blog-media.s3.%'
UNION ALL
SELECT 'posts.content_html',       COUNT(*)              FROM posts         WHERE content_html LIKE '%strix-blog-media.s3.%'
UNION ALL
SELECT 'chat_messages.image_url',  COUNT(*)              FROM chat_messages WHERE image_url    LIKE 'https://strix-blog-media.s3.%';

COMMIT;
