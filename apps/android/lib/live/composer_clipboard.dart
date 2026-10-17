import 'package:flutter/material.dart';
import 'gateway.dart';

Future<void> pasteComposerClipboard(
  LiveController controller,
  TextEditingController text,
) async {
  final before = text.value;
  await controller.pasteClipboard((inserted) {
    // Reading provider images may take time. Do not replace a newer edit.
    if (text.value != before) return;
    final selection = before.selection.isValid
        ? before.selection
        : TextSelection.collapsed(offset: before.text.length);
    final updated = before.text.replaceRange(
      selection.start,
      selection.end,
      inserted,
    );
    text.value = TextEditingValue(
      text: updated,
      selection: TextSelection.collapsed(
        offset: selection.start + inserted.length,
      ),
    );
    controller.editDraft(updated);
  });
}

class ComposerClipboardMenu extends StatefulWidget {
  const ComposerClipboardMenu({
    super.key,
    required this.controller,
    required this.text,
    required this.editable,
  });
  final LiveController controller;
  final TextEditingController text;
  final EditableTextState editable;

  @override
  State<ComposerClipboardMenu> createState() => _ComposerClipboardMenuState();
}

class _ComposerClipboardMenuState extends State<ComposerClipboardMenu> {
  late final Future<bool> hasImages = widget.controller.gateway
      .call('clipboardImagesAvailable')
      .then((value) => value == true, onError: (_) => false);

  void paste() {
    widget.editable.hideToolbar();
    pasteComposerClipboard(widget.controller, widget.text);
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<bool>(
    future: hasImages,
    builder: (context, snapshot) {
      final items = [
        for (final item in widget.editable.contextMenuButtonItems)
          if (item.type == ContextMenuButtonType.paste)
            ContextMenuButtonItem(
              type: ContextMenuButtonType.paste,
              onPressed: paste,
            )
          else
            item,
      ];
      if (snapshot.data == true &&
          !items.any((item) => item.type == ContextMenuButtonType.paste)) {
        items.insert(
          0,
          ContextMenuButtonItem(
            type: ContextMenuButtonType.paste,
            onPressed: paste,
          ),
        );
      }
      return AdaptiveTextSelectionToolbar.buttonItems(
        anchors: widget.editable.contextMenuAnchors,
        buttonItems: items,
      );
    },
  );
}
