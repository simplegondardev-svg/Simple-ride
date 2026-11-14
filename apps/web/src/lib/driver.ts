"use client";

import { useState, useCallback, useRef } from "react";
import { api, isPhoneNotVerifiedError } from "./api";

export interface DriverLocation {
  lat: number;
  lng: number;
  heading?: number;
}

export interface DriverOffer {
  id: string;
  tripId: string;
  pickupAddress: string;
  dropoffAddress: string;
  fare: number;
}

export interface RefundRequest {
  amount?: number;
  reason?: string;
}

/**
 * Driver protected actions requiring verified phone number.
 * When the backend throws PHONE_NOT_VERIFIED (HTTP 403), these helpers
 * throw an ApiError with code === "PHONE_NOT_VERIFIED" so the frontend
 * can display the phone verification prompt instead of a generic error.
 */

/** Go online at the given location (requires approved driver and verified phone) */
export async function driverGoOnline(location: DriverLocation) {
  return api("drivers/me/online", {
    method: "POST",
    body: location,
  });
}

/** View currently available trip offers for driver (requires verified phone) */
export async function driverGetOffers(): Promise<{ data: DriverOffer[] }> {
  return api<{ data: DriverOffer[] }>("drivers/me/offers");
}

/** Accept an open trip offer (requires verified phone) */
export async function driverAcceptTrip(tripId: string) {
  return api(`trips/${tripId}/accept`, {
    method: "POST",
  });
}

/** Request deposit refund (requires verified phone) */
export async function driverRequestRefund(body: RefundRequest = {}) {
  return api("drivers/me/refunds", {
    method: "POST",
    body,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification-Aware Protected Action Runner & Hook
// ─────────────────────────────────────────────────────────────────────────────

export interface ProtectedActionState<T = unknown> {
  isBusy: boolean;
  needsVerification: boolean;
  error: string | null;
  lastResult: T | null;
}

export interface ProtectedActionRunner<T = unknown, A extends unknown[] = unknown[]> {
  execute: (...args: A) => Promise<T | undefined>;
  handleVerified: () => Promise<T | undefined>;
  handleCancel: () => void;
  getState: () => ProtectedActionState<T>;
  subscribe: (listener: (state: ProtectedActionState<T>) => void) => () => void;
}

/**
 * Creates a verification-aware action runner that:
 * 1. Executes the protected action.
 * 2. On PHONE_NOT_VERIFIED, opens the verification prompt and preserves the intended action.
 * 3. On verification completion (handleVerified), automatically retries the action once.
 * 4. Prevents duplicate submissions and repeated automatic retries.
 * 5. Does not retry when cancelled or when verification fails.
 * 6. Shows ordinary errors normally.
 */
export function createProtectedActionRunner<T, A extends unknown[]>(
  action: (...args: A) => Promise<T>,
  _options?: { actionName?: string }
): ProtectedActionRunner<T, A> {
  let isBusy = false;
  let needsVerification = false;
  let error: string | null = null;
  let lastResult: T | null = null;
  let pendingArgs: A | null = null;
  const listeners = new Set<(state: ProtectedActionState<T>) => void>();

  function notify() {
    const state: ProtectedActionState<T> = {
      isBusy,
      needsVerification,
      error,
      lastResult,
    };
    for (const listener of listeners) {
      listener(state);
    }
  }

  return {
    async execute(...args: A): Promise<T | undefined> {
      // Prevent duplicate concurrent submissions
      if (isBusy) {
        return undefined;
      }

      isBusy = true;
      error = null;
      pendingArgs = args;
      notify();

      try {
        const result = await action(...args);
        lastResult = result;
        pendingArgs = null;
        needsVerification = false;
        error = null;
        isBusy = false;
        notify();
        return result;
      } catch (err: unknown) {
        if (isPhoneNotVerifiedError(err)) {
          // Detect PHONE_NOT_VERIFIED: prompt verification and preserve action
          needsVerification = true;
          error = null;
          isBusy = false;
          notify();
          return undefined;
        } else {
          // Normal error handling for other errors
          pendingArgs = null;
          needsVerification = false;
          error = (err as Error)?.message ?? "An error occurred";
          isBusy = false;
          notify();
          throw err;
        }
      }
    },

    async handleVerified(): Promise<T | undefined> {
      // Only retry if verification was requested, we have pending args, and not already busy
      if (!needsVerification || !pendingArgs || isBusy) {
        return undefined;
      }

      const argsToRetry = pendingArgs;
      // Clear pending action immediately to prevent repeated automatic retries
      pendingArgs = null;
      needsVerification = false;
      isBusy = true;
      error = null;
      notify();

      try {
        const result = await action(...argsToRetry);
        lastResult = result;
        isBusy = false;
        notify();
        return result;
      } catch (err: unknown) {
        // Do not retry automatically again on failure
        isBusy = false;
        error = (err as Error)?.message ?? "An error occurred after verification";
        notify();
        throw err;
      }
    },

    handleCancel() {
      // Cancel verification: clear preserved action and do not retry
      pendingArgs = null;
      needsVerification = false;
      isBusy = false;
      notify();
    },

    getState() {
      return { isBusy, needsVerification, error, lastResult };
    },

    subscribe(listener: (state: ProtectedActionState<T>) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Action runner for driver going online */
export function createDriverOnlineRunner() {
  return createProtectedActionRunner(driverGoOnline, { actionName: "go_online" });
}

/** Action runner for driver viewing offers */
export function createDriverOffersRunner() {
  return createProtectedActionRunner(driverGetOffers, { actionName: "get_offers" });
}

/** Action runner for driver accepting a trip */
export function createDriverAcceptTripRunner() {
  return createProtectedActionRunner(driverAcceptTrip, { actionName: "accept_trip" });
}

/** Action runner for driver requesting a refund */
export function createDriverRefundRunner() {
  return createProtectedActionRunner(driverRequestRefund, { actionName: "request_refund" });
}

/**
 * React hook for UI components to execute protected actions with verification handling.
 */
export function useProtectedAction<T, A extends unknown[]>(
  action: (...args: A) => Promise<T>,
  _options?: { actionName?: string }
) {
  const [isBusy, setIsBusy] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<T | null>(null);
  const pendingArgsRef = useRef<A | null>(null);

  const execute = useCallback(
    async (...args: A): Promise<T | undefined> => {
      if (isBusy) return undefined;
      setIsBusy(true);
      setError(null);
      pendingArgsRef.current = args;

      try {
        const result = await action(...args);
        setLastResult(result);
        pendingArgsRef.current = null;
        setNeedsVerification(false);
        setIsBusy(false);
        return result;
      } catch (err: unknown) {
        if (isPhoneNotVerifiedError(err)) {
          setNeedsVerification(true);
          setError(null);
          setIsBusy(false);
          return undefined;
        } else {
          pendingArgsRef.current = null;
          setNeedsVerification(false);
          setError((err as Error)?.message ?? "An error occurred");
          setIsBusy(false);
          throw err;
        }
      }
    },
    [action, isBusy]
  );

  const handleVerified = useCallback(async (): Promise<T | undefined> => {
    if (!needsVerification || !pendingArgsRef.current || isBusy) return undefined;
    const argsToRetry = pendingArgsRef.current;
    pendingArgsRef.current = null;
    setNeedsVerification(false);
    setIsBusy(true);
    setError(null);

    try {
      const result = await action(...argsToRetry);
      setLastResult(result);
      setIsBusy(false);
      return result;
    } catch (err: unknown) {
      setIsBusy(false);
      setError((err as Error)?.message ?? "An error occurred after verification");
      throw err;
    }
  }, [action, isBusy, needsVerification]);

  const handleCancel = useCallback(() => {
    pendingArgsRef.current = null;
    setNeedsVerification(false);
    setIsBusy(false);
  }, []);

  return {
    execute,
    handleVerified,
    handleCancel,
    isBusy,
    needsVerification,
    error,
    lastResult,
  };
}
