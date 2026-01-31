import crypto from "node:crypto";
import bcrypt from "bcrypt";

export const generateRandomPassword = async () => {
	const passwordLength = 16;

	const characters =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

	let randomPassword = "";
	for (let i = 0; i < passwordLength; i++) {
		const randomIndex = crypto.randomInt(0, characters.length);
		randomPassword += characters.charAt(randomIndex);
	}

	const saltRounds = 10;

	const hashedPassword = await bcrypt.hash(randomPassword, saltRounds);
	return { randomPassword, hashedPassword };
};
