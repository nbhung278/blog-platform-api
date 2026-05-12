import { prisma } from "../db";
import { expandPermissions, type PermissionKey } from "./permissions";

export async function loadUserRolesAndPermissions(userId: string): Promise<{
	roles: string[];
	permissions: PermissionKey[];
}> {
	const userRoles = await prisma.userRole.findMany({
		where: { userId },
		include: {
			role: {
				include: {
					permissions: { include: { permission: { select: { key: true } } } },
				},
			},
		},
	});

	const roles = userRoles.map((ur) => ur.role.key);
	const permissionSet = new Set<string>();
	for (const ur of userRoles) {
		for (const rp of ur.role.permissions) {
			permissionSet.add(rp.permission.key);
		}
	}

	return {
		roles,
		permissions: expandPermissions(Array.from(permissionSet) as PermissionKey[]),
	};
}
