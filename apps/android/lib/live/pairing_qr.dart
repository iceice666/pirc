import 'package:flutter/widgets.dart';
import 'package:qr/qr.dart';

const int _pairingQrQuietZone = 4;

/// Creates a QR module matrix matching the Pirc web pairing QR settings.
///
/// The returned matrix includes a four-module white quiet zone on every side.
List<List<bool>> pairingQrModules(String data) {
  final code = QrCode.fromData(
    data: data,
    errorCorrectLevel: QrErrorCorrectLevel.M,
  );
  QrImage? image;
  var lowestPenalty = 1 << 62;
  for (var maskPattern = 0; maskPattern < 8; maskPattern++) {
    final candidate = QrImage.withMaskPattern(code, maskPattern);
    final penalty = _uqrPenalty(candidate);
    if (penalty < lowestPenalty) {
      lowestPenalty = penalty;
      image = candidate;
    }
  }
  final selectedImage = image!;
  final dimension = selectedImage.moduleCount + _pairingQrQuietZone * 2;

  return List<List<bool>>.generate(dimension, (row) {
    return List<bool>.generate(dimension, (column) {
      final sourceRow = row - _pairingQrQuietZone;
      final sourceColumn = column - _pairingQrQuietZone;
      if (sourceRow < 0 ||
          sourceColumn < 0 ||
          sourceRow >= selectedImage.moduleCount ||
          sourceColumn >= selectedImage.moduleCount) {
        return false;
      }
      return selectedImage.isDark(sourceRow, sourceColumn);
    }, growable: false);
  }, growable: false);
}

int _uqrPenalty(QrImage image) {
  final dimension = image.moduleCount;
  var score = 0;

  void addRunHistory(int runLength, List<int> history) {
    if (history.first == 0) runLength += dimension;
    history
      ..removeLast()
      ..insert(0, runLength);
  }

  int countFinderPatterns(List<int> history) {
    final unit = history[1];
    final core =
        unit > 0 &&
        history[2] == unit &&
        history[3] == unit * 3 &&
        history[4] == unit &&
        history[5] == unit;
    if (!core) return 0;
    return ((history[0] >= unit * 4 && history[6] >= unit) ? 1 : 0) +
        ((history[6] >= unit * 4 && history[0] >= unit) ? 1 : 0);
  }

  void scoreLine(bool Function(int index) isDarkAt) {
    var runColor = false;
    var runLength = 0;
    final history = List<int>.filled(7, 0, growable: true);
    for (var index = 0; index < dimension; index++) {
      final color = isDarkAt(index);
      if (color == runColor) {
        runLength++;
        if (runLength == 5) {
          score += 3;
        } else if (runLength > 5) {
          score++;
        }
      } else {
        addRunHistory(runLength, history);
        if (!runColor) score += countFinderPatterns(history) * 40;
        runColor = color;
        runLength = 1;
      }
    }

    var finalRunLength = runLength;
    if (runColor) {
      addRunHistory(finalRunLength, history);
      finalRunLength = 0;
    }
    finalRunLength += dimension;
    addRunHistory(finalRunLength, history);
    score += countFinderPatterns(history) * 40;
  }

  for (var row = 0; row < dimension; row++) {
    scoreLine((column) => image.isDark(row, column));
  }
  for (var column = 0; column < dimension; column++) {
    scoreLine((row) => image.isDark(row, column));
  }

  for (var row = 0; row < dimension - 1; row++) {
    for (var column = 0; column < dimension - 1; column++) {
      final color = image.isDark(row, column);
      if (color == image.isDark(row + 1, column) &&
          color == image.isDark(row, column + 1) &&
          color == image.isDark(row + 1, column + 1)) {
        score += 3;
      }
    }
  }

  var darkCount = 0;
  for (var row = 0; row < dimension; row++) {
    for (var column = 0; column < dimension; column++) {
      if (image.isDark(row, column)) darkCount++;
    }
  }
  final total = dimension * dimension;
  final balancePenalty =
      ((darkCount * 20 - total * 10).abs() / total).ceil() - 1;
  score += balancePenalty * 10;

  return score;
}

/// A crisp, Flutter-rendered pairing QR code.
class PairingQr extends StatelessWidget {
  const PairingQr({super.key, required this.data, this.size = 200})
    : assert(size > 0);

  final String data;
  final double size;

  @override
  Widget build(BuildContext context) {
    final modules = pairingQrModules(data);
    return Semantics(
      label: 'Pairing QR code',
      image: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: SizedBox.square(
          dimension: size,
          child: CustomPaint(
            painter: _PairingQrPainter(modules),
            size: Size.square(size),
          ),
        ),
      ),
    );
  }
}

class _PairingQrPainter extends CustomPainter {
  const _PairingQrPainter(this.modules);

  final List<List<bool>> modules;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(
      Offset.zero & size,
      Paint()..color = const Color(0xffffffff),
    );

    final matrixSize = modules.length;
    final darkModules = Path();
    for (var row = 0; row < matrixSize; row++) {
      var column = 0;
      while (column < matrixSize) {
        if (!modules[row][column]) {
          column++;
          continue;
        }
        final start = column;
        while (column < matrixSize && modules[row][column]) {
          column++;
        }
        darkModules.addRect(
          Rect.fromLTRB(
            start.toDouble(),
            row.toDouble(),
            column.toDouble(),
            row + 1.0,
          ),
        );
      }
    }

    canvas.save();
    canvas.scale(size.width / matrixSize, size.height / matrixSize);
    canvas.drawPath(
      darkModules,
      Paint()
        ..color = const Color(0xff000000)
        ..isAntiAlias = false,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _PairingQrPainter oldDelegate) =>
      !identical(modules, oldDelegate.modules);
}
