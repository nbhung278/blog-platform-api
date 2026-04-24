export const PERMISSIONS = {
	POST_WRITE_OWN: "post:write:own",
	POST_WRITE_ANY: "post:write:any",
	POST_PUBLISH_ANY: "post:publish:any",
	POST_DELETE_OWN: "post:delete:own",
	POST_DELETE_ANY: "post:delete:any",
	COMMENT_MODERATE: "comment:moderate",
	COMMENT_DELETE_ANY: "comment:delete:any",
	ANALYTICS_VIEW: "analytics:view",
	USER_MANAGE: "user:manage",
	ROLE_MANAGE: "role:manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
	[PERMISSIONS.POST_WRITE_OWN]: "Create and edit own posts",
	[PERMISSIONS.POST_WRITE_ANY]: "Create and edit any post",
	[PERMISSIONS.POST_PUBLISH_ANY]: "Publish or unpublish any post",
	[PERMISSIONS.POST_DELETE_OWN]: "Delete own posts",
	[PERMISSIONS.POST_DELETE_ANY]: "Delete any post",
	[PERMISSIONS.COMMENT_MODERATE]: "Moderate comments (hide, approve)",
	[PERMISSIONS.COMMENT_DELETE_ANY]: "Delete any comment",
	[PERMISSIONS.ANALYTICS_VIEW]: "View analytics dashboard",
	[PERMISSIONS.USER_MANAGE]: "Manage users (create, deactivate)",
	[PERMISSIONS.ROLE_MANAGE]: "Manage roles and assign permissions",
};

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
			PERMISSIONS.COMMENT_MODERATE,
			PERMISSIONS.COMMENT_DELETE_ANY,
			PERMISSIONS.ANALYTICS_VIEW,
		],
	},
	{
		key: ROLE_KEYS.AUTHOR,
		name: "Author",
		description: "Write and manage own posts",
		permissions: [PERMISSIONS.POST_WRITE_OWN, PERMISSIONS.POST_DELETE_OWN],
	},
];
