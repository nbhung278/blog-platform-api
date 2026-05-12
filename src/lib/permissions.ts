export const PERMISSIONS = {
	POST_VIEW_ANY: "post:view:any",
	POST_WRITE_OWN: "post:write:own",
	POST_WRITE_ANY: "post:write:any",
	POST_PUBLISH_ANY: "post:publish:any",
	POST_DELETE_OWN: "post:delete:own",
	POST_DELETE_ANY: "post:delete:any",
	POST_REVIEW: "post:review",
	MEDIA_UPLOAD: "media:upload",
	COMMENT_MODERATE: "comment:moderate",
	COMMENT_DELETE_ANY: "comment:delete:any",
	ANALYTICS_VIEW: "analytics:view",
	CATEGORY_MANAGE: "category:manage",
	USER_VIEW: "user:view",
	USER_MANAGE: "user:manage",
	ROLE_VIEW: "role:view",
	ROLE_MANAGE: "role:manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

// Holding any of these means the user can sign into the admin panel.
// Used by /login to skip the device-OTP step-up for admins — admins
// log in from many devices (work, home, oncall laptop) and the friction
// of an email round-trip every time isn't worth the marginal protection.
export const ADMIN_PANEL_PERMISSIONS: PermissionKey[] = [
	PERMISSIONS.POST_VIEW_ANY,
	PERMISSIONS.POST_WRITE_OWN,
	PERMISSIONS.POST_WRITE_ANY,
	PERMISSIONS.POST_PUBLISH_ANY,
	PERMISSIONS.POST_REVIEW,
	PERMISSIONS.COMMENT_MODERATE,
	PERMISSIONS.ANALYTICS_VIEW,
	PERMISSIONS.CATEGORY_MANAGE,
	PERMISSIONS.USER_VIEW,
	PERMISSIONS.USER_MANAGE,
	PERMISSIONS.ROLE_VIEW,
	PERMISSIONS.ROLE_MANAGE,
];

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
	[PERMISSIONS.POST_VIEW_ANY]: "View any post (including others' drafts/pending)",
	[PERMISSIONS.POST_WRITE_OWN]: "Create and edit own posts",
	[PERMISSIONS.POST_WRITE_ANY]: "Create and edit any post",
	[PERMISSIONS.POST_PUBLISH_ANY]: "Publish or unpublish any post",
	[PERMISSIONS.POST_DELETE_OWN]: "Delete own posts",
	[PERMISSIONS.POST_DELETE_ANY]: "Delete any post",
	[PERMISSIONS.POST_REVIEW]: "Review pending posts (approve / reject)",
	[PERMISSIONS.MEDIA_UPLOAD]: "Upload media files (images) to storage",
	[PERMISSIONS.COMMENT_MODERATE]: "Moderate comments (hide, approve)",
	[PERMISSIONS.COMMENT_DELETE_ANY]: "Delete any comment",
	[PERMISSIONS.ANALYTICS_VIEW]: "View analytics dashboard",
	[PERMISSIONS.CATEGORY_MANAGE]: "Manage post categories (create, edit, delete)",
	[PERMISSIONS.USER_VIEW]: "View users list (read-only)",
	[PERMISSIONS.USER_MANAGE]: "Manage users (create, deactivate)",
	[PERMISSIONS.ROLE_VIEW]: "View roles and permissions (read-only)",
	[PERMISSIONS.ROLE_MANAGE]: "Manage roles and assign permissions",
};

// Implicit-view rules: holding the "manage/write" permission implicitly grants
// the matching "view" permission. Keeps role configs from being verbose and
// avoids the "I can edit but can't open the page" footgun.
const IMPLIES: Record<string, PermissionKey[]> = {
	[PERMISSIONS.POST_WRITE_ANY]: [PERMISSIONS.POST_VIEW_ANY],
	[PERMISSIONS.POST_REVIEW]: [PERMISSIONS.POST_VIEW_ANY],
	[PERMISSIONS.POST_PUBLISH_ANY]: [PERMISSIONS.POST_VIEW_ANY],
	[PERMISSIONS.POST_DELETE_ANY]: [PERMISSIONS.POST_VIEW_ANY],
	[PERMISSIONS.USER_MANAGE]: [PERMISSIONS.USER_VIEW],
	[PERMISSIONS.ROLE_MANAGE]: [PERMISSIONS.ROLE_VIEW],
};

// Expand a flat permission list to include all implied permissions.
// Used at token-issue / `/me` time so the JWT carries the full effective set.
export function expandPermissions(perms: readonly PermissionKey[]): PermissionKey[] {
	const out = new Set<PermissionKey>(perms);
	for (const p of perms) {
		const implied = IMPLIES[p];
		if (implied) for (const i of implied) out.add(i);
	}
	return Array.from(out);
}

export const ROLE_KEYS = {
	SUPER_ADMIN: "super_admin",
	ADMIN: "admin",
	AUTHOR: "author",
} as const;

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

export const DEFAULT_ROLES: Array<{
	key: RoleKey;
	name: string;
	description: string;
	permissions: PermissionKey[];
}> = [
	{
		key: ROLE_KEYS.SUPER_ADMIN,
		name: "Super Admin",
		description: "Full access to everything, including role management",
		permissions: ALL_PERMISSIONS,
	},
	{
		key: ROLE_KEYS.ADMIN,
		name: "Admin",
		description: "Manage content and moderate comments",
		permissions: [
			PERMISSIONS.POST_WRITE_ANY,
			PERMISSIONS.POST_PUBLISH_ANY,
			PERMISSIONS.POST_DELETE_ANY,
			PERMISSIONS.POST_REVIEW,
			PERMISSIONS.MEDIA_UPLOAD,
			PERMISSIONS.COMMENT_MODERATE,
			PERMISSIONS.COMMENT_DELETE_ANY,
			PERMISSIONS.ANALYTICS_VIEW,
			PERMISSIONS.CATEGORY_MANAGE,
		],
	},
	{
		key: ROLE_KEYS.AUTHOR,
		name: "Author",
		description: "Write and manage own posts",
		permissions: [
			PERMISSIONS.POST_WRITE_OWN,
			PERMISSIONS.POST_DELETE_OWN,
			PERMISSIONS.MEDIA_UPLOAD,
		],
	},
];
