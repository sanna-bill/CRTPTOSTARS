import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  User, 
  signInWithCustomToken,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInAnonymously
} from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, serverTimestamp, collection, onSnapshot, query, orderBy, limit, addDoc, where } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const googleProvider = new GoogleAuthProvider();

export { 
  signInWithPopup, 
  signInWithCustomToken,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInAnonymously,
  onAuthStateChanged, 
  doc, 
  setDoc, 
  getDoc, 
  serverTimestamp, 
  collection, 
  onSnapshot, 
  query, 
  orderBy, 
  limit,
  addDoc,
  where
};
export type { User };
