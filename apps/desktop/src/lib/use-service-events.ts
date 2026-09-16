import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ipcEvents } from "@/lib/ipc";

/**
 * Subscribes to supervised-service state transitions.
 *
 * Every transition invalidates the status, pool and metrics queries so badges
 * update the moment a service changes state instead of at the next poll; the
 * pages' own refetch intervals remain as a fallback. The §98 notification
 * center is in that list: a transition is exactly what its badge counts.
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
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, [queryClient]);
}
