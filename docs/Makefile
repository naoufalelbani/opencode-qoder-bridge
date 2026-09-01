IN := qoder-sdk-1.0.31-upgrade.md
OUT := qoder-sdk-1.0.31-upgrade.pdf

all: $(OUT)

$(OUT): $(IN)
	pandoc '$(IN)' -o '$(OUT)'

preview:
	zathura --fork --log-level=error '$(OUT)'

watch:
	echo '$(IN)' | entr -c make

edit:
	nohup gedit '$(IN)' >/dev/null &