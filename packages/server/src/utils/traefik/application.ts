import fs, { createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { paths } from "@dokploy/server/constants";
import type { Domain } from "@dokploy/server/services/domain";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import { encodeBase64 } from "../docker/utils";
import { execAsyncRemote } from "../process/execAsync";
import type { FileConfig, HttpLoadBalancerService } from "./file-types";

/**
 * Sanitize appName to prevent path traversal attacks
 * Uses path.basename to strip any directory traversal attempts
 */
const sanitizeAppName = (appName: string): string => {
	return path.basename(appName);
};

export const createTraefikConfig = (appName: string) => {
	const sanitizedAppName = sanitizeAppName(appName);
	const defaultPort = 3000;
	const serviceURLDefault = `http://${sanitizedAppName}:${defaultPort}`;
	const domainDefault = `Host(\`${sanitizedAppName}.docker.localhost\`)`;
	const config: FileConfig = {
		http: {
			routers: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${sanitizedAppName}-router-1`]: {
								rule: domainDefault,
								service: `${sanitizedAppName}-service-1`,
								entryPoints: ["web"],
							},
						}),
			},

			services: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${sanitizedAppName}-service-1`]: {
								loadBalancer: {
									servers: [{ url: serviceURLDefault }],
									passHostHeader: true,
								},
							},
						}),
			},
		},
	};
	const yamlStr = stringify(config);
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	fs.mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(
		path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`),
		yamlStr,
		"utf8",
	);
};

export const removeTraefikConfig = async (
	appName: string,
	serverId?: string | null,
) => {
	try {
		const sanitizedAppName = sanitizeAppName(appName);
		const { DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);

		if (serverId) {
			await execAsyncRemote(serverId, `rm ${quote([configPath])}`);
		} else {
			if (fs.existsSync(configPath)) {
				await fs.promises.unlink(configPath);
			}
		}
		if (fs.existsSync(configPath)) {
			await fs.promises.unlink(configPath);
		}
	} catch {}
};

export const removeTraefikConfigRemote = async (
	appName: string,
	serverId: string,
) => {
	try {
		const sanitizedAppName = sanitizeAppName(appName);
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
		await execAsyncRemote(serverId, `rm ${quote([configPath])}`);
	} catch {}
};

export const loadOrCreateConfig = (appName: string): FileConfig => {
	const sanitizedAppName = sanitizeAppName(appName);
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
	if (fs.existsSync(configPath)) {
		const yamlStr = fs.readFileSync(configPath, "utf8");
		const parsedConfig = (parse(yamlStr) as FileConfig) || {
			http: { routers: {}, services: {} },
		};
		return parsedConfig;
	}
	return { http: { routers: {}, services: {} } };
};

export const loadOrCreateConfigRemote = async (
	serverId: string,
	appName: string,
) => {
	const sanitizedAppName = sanitizeAppName(appName);
	const { DYNAMIC_TRAEFIK_PATH } = paths(true);
	const fileConfig: FileConfig = { http: { routers: {}, services: {} } };
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
	try {
		const { stdout } = await execAsyncRemote(serverId, `cat ${quote([configPath])}`);

		if (!stdout) return fileConfig;

		const parsedConfig = (parse(stdout) as FileConfig) || {
			http: { routers: {}, services: {} },
		};
		return parsedConfig;
	} catch {
		return fileConfig;
	}
};

export const readConfig = (appName: string) => {
	const sanitizedAppName = sanitizeAppName(appName);
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
	if (fs.existsSync(configPath)) {
		const yamlStr = fs.readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const readRemoteConfig = async (serverId: string, appName: string) => {
	const sanitizedAppName = sanitizeAppName(appName);
	const { DYNAMIC_TRAEFIK_PATH } = paths(true);
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
	try {
		const { stdout } = await execAsyncRemote(serverId, `cat ${quote([configPath])}`);
		if (!stdout) return null;
		return stdout;
	} catch {
		return null;
	}
};

export const readMonitoringConfig = async (readAll = false) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, "access.log");
	if (fs.existsSync(configPath)) {
		if (!readAll) {
			// Read first 500 lines using streams
			let content = "";
			let validCount = 0;

			const fileStream = createReadStream(configPath, { encoding: "utf8" });
			const readline = createInterface({
				input: fileStream,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			for await (const line of readline) {
				try {
					const trimmed = line.trim();
					if (
						trimmed !== "" &&
						trimmed.startsWith("{") &&
						trimmed.endsWith("}")
					) {
						const log = JSON.parse(trimmed);
						// Exclude Dokploy service app and Dashboard requests
						if (log.ServiceName !== "dokploy-service-app@file") {
							content += `${line}\n`;
							validCount++;
							if (validCount >= 500) {
								break;
							}
						}
					}
				} catch {
					// Ignore invalid JSON
				}
			}
			return content;
		}
		return fs.readFileSync(configPath, "utf8");
	}
	return null;
};

export const readConfigInPath = async (pathFile: string, serverId?: string) => {
	const configPath = path.join(pathFile);

	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, `cat ${configPath}`);
		if (!stdout) return null;
		return stdout;
	}
	if (fs.existsSync(configPath)) {
		const yamlStr = fs.readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeConfig = (appName: string, traefikConfig: string) => {
	try {
		const sanitizedAppName = sanitizeAppName(appName);
		const { DYNAMIC_TRAEFIK_PATH } = paths();
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
		fs.writeFileSync(configPath, traefikConfig, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeConfigRemote = async (
	serverId: string,
	appName: string,
	traefikConfig: string,
) => {
	try {
		const sanitizedAppName = sanitizeAppName(appName);
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
		const encoded = encodeBase64(traefikConfig);
		await execAsyncRemote(
			serverId,
			`echo ${quote([encoded])} | base64 -d > ${quote([configPath])}`,
		);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfigInPath = async (
	pathFile: string,
	traefikConfig: string,
	serverId?: string,
) => {
	try {
		const configPath = path.join(pathFile);
		if (serverId) {
			const encoded = encodeBase64(traefikConfig);
			await execAsyncRemote(
				serverId,
				`echo ${quote([encoded])} | base64 -d > ${quote([configPath])}`,
			);
		} else {
			fs.writeFileSync(configPath, traefikConfig, "utf8");
		}
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfig = (
	traefikConfig: FileConfig,
	appName: string,
) => {
	try {
		const sanitizedAppName = sanitizeAppName(appName);
		const { DYNAMIC_TRAEFIK_PATH } = paths();
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
		const yamlStr = stringify(traefikConfig);
		fs.writeFileSync(configPath, yamlStr, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfigRemote = async (
	traefikConfig: FileConfig,
	appName: string,
	serverId: string,
) => {
	try {
		const sanitizedAppName = sanitizeAppName(appName);
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${sanitizedAppName}.yml`);
		const yamlStr = stringify(traefikConfig);
		const encoded = encodeBase64(yamlStr);
		await execAsyncRemote(serverId, `echo ${quote([encoded])} | base64 -d > ${quote([configPath])}`);
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const createServiceConfig = (
	appName: string,
	domain: Domain,
): {
	loadBalancer: HttpLoadBalancerService;
} => ({
	loadBalancer: {
		servers: [{ url: `http://${appName}:${domain.port || 80}` }],
		passHostHeader: true,
	},
});
