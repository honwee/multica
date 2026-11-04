import AsyncStorage from "@react-native-async-storage/async-storage";
import type { User } from "@multica/core/types";
import { UserSchema } from "@/data/schemas";

const USER_KEY = "multica-mobile-cached-user-v1";

export async function readCachedUser(): Promise<User | null> {
  const raw = await AsyncStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = UserSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.id ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeCachedUser(user: User): Promise<void> {
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function clearCachedUser(): Promise<void> {
  await AsyncStorage.removeItem(USER_KEY);
}
