import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import type { AnnotateTransport } from './annotate';

export interface FirebaseTransportOptions {
  /** Your initialized Firebase app. */
  app: FirebaseApp;
  /** Same value as the Annotate `reviewId` config. Letters, digits, `_` and `-`. */
  reviewId: string;
  /** Top-level collection holding reviews. Default "annotateReviews". Must match your security rules. */
  root?: string;
  /** Use a specific Firestore instance (an emulator, a named database). Default getFirestore(app). */
  firestore?: Firestore;
  /** Use a specific Auth instance. Default getAuth(app). */
  auth?: Auth;
  /** Called when nobody is signed in. Default: anonymous sign-in. */
  signIn?: (auth: Auth) => Promise<unknown>;
  /** Days a deleted comment's tombstone is kept (`purgeAt`, for a Firestore TTL policy). Default 30. */
  purgeAfterDays?: number;
}

export function firebaseTransport(options: FirebaseTransportOptions): AnnotateTransport;
export default firebaseTransport;
