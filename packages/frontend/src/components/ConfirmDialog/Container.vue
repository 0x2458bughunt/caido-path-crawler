<script setup lang="ts">
import Button from "primevue/button";

defineProps<{
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <div class="flex flex-col gap-4 min-w-[320px] max-w-[420px] p-1">
    <p class="m-0 text-sm text-surface-100 whitespace-pre-wrap leading-relaxed">
      {{ message }}
    </p>
    <div class="flex justify-end gap-2">
      <Button
        :label="cancelLabel ?? 'Cancel'"
        severity="secondary"
        size="small"
        outlined
        @click="emit('cancel')"
      />
      <Button
        :label="confirmLabel ?? 'Delete'"
        :severity="danger === false ? 'primary' : 'danger'"
        size="small"
        @click="emit('confirm')"
      />
    </div>
  </div>
</template>
