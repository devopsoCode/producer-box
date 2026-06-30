
### /etc/sudoers.d/producerbox
```
user ALL=(root) NOPASSWD: /srv/producerbox/producerbox.sh
user ALL=(root) NOPASSWD: /srv/producerbox/premsfix.sh
```

### /srv/producerbox/producerbox.sh

```
#!/bin/bash
set -e
cd /var/www/magento
chown -R user:user .
cd /var/www/next
chown -R user:user .
```

### /srv/producerbox/premsfix.sh

```
cd /srv/devdiabeticshoeshub/backend
chown www-data:www-data -R var
chown www-data:www-data -R generated
chown www-data:www-data -R pub/static pub/media
find -type d -exec chmod 755 {} +
find -type f -exec chmod 644 {} +
chmod 755 bin/magento
```

### Last setup commands
```
sudo chmod 440 /etc/sudoers.d/producerbox
sudo chmod 700 /srv/producerbox/producerbox.sh
sudo chmod 700 /srv/producerbox/premsfix.sh 
```
