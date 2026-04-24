import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ALL_PERMISSIONS, DEFAULT_ROLES, PERMISSION_DESCRIPTIONS } from "../src/lib/permissions";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
	console.log("[seed] Upserting permissions...");
	for (const key of ALL_PERMISSIONS) {
		await prisma.permission.upsert({
			where: { key },
			update: { description: PERMISSION_DESCRIPTIONS[key] },
			create: { key, description: PERMISSION_DESCRIPTIONS[key] },
		});
	}

	console.log("[seed] Upserting roles + assignments...");
	for (const role of DEFAULT_ROLES) {
		const dbRole = await prisma.role.upsert({
			where: { key: role.key },
			update: { name: role.name, description: role.description, isSystem: true },
			create: {
				key: role.key,
				name: role.name,
				description: role.description,
				isSystem: true,
			},
		});

		const permissions = await prisma.permission.findMany({
			where: { key: { in: role.permissions } },
			select: { id: true },
		});

		await prisma.rolePermission.deleteMany({ where: { roleId: dbRole.id } });
		await prisma.rolePermission.createMany({
			data: permissions.map((p) => ({ roleId: dbRole.id, permissionId: p.id })),
		});
	}

	const userCount = await prisma.user.count();
	if (userCount === 0) {
		console.log("");
		console.log("[seed] No users in DB yet.");
		console.log("[seed] Open the admin app and complete the setup wizard at /setup");
		console.log("[seed] to create the first super_admin account.");
		console.log("");
	}

	console.log("[seed] Done.");
}

main()
	.catch((err) => {
		console.error(err);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
