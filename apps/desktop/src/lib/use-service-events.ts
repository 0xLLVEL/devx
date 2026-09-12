import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ipcEvents } from "@/lib/ipc";

/**
 * Subscribes to supervised-service state transitions.
 *
 * Every transition invalidates the status, pool and metrics queries so badges
 * update the moment a service changes state instead of at the next poll; the
 * pages' own refetch intervals remain as a fallback.
 */
export function useServiceEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = ipcEvents.serviceEventUpdate.listen((event) => {
      const { id } = event.payload.event;
      void queryClient.invalidateQueries({ queryKey: ["service-status", id] });
      void queryClient.invalidateQueries({ queryKey: ["php-pool-status"] });
      void queryClient.invalidateQueries({ queryKey: ["worker-list"] });
      void queryClient.invalidateQueries({ queryKey: ["service-metrics"] });
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, [queryClient]);
}
